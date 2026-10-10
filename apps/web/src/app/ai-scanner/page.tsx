'use client';

import React, { useEffect, useState, useRef } from 'react';
import { Card } from '@/components/ui/Card';
import { 
  UploadCloud, FileText, Camera, CheckCircle2, AlertCircle, 
  ScanLine, Bot, Sparkles, Layers, Edit3, FileDown, CheckSquare, XCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '@/components/ui/Toast';
import { useRouter } from 'next/navigation';
import { ocrApi, type OcrDocumentType, type OcrMatchedItem, type OcrScanResult } from '@/lib/api-client';
import { describeApiError, getApiErrorCode, getApiErrorDetails } from '@/lib/api-error';
import { OCR_PHOTO_MAX_EDGE, photoForUpload } from '@/lib/photo';
import { PENDING_SCAN_KEY } from '@/lib/smart-capture';
import { dataUrlToBlob } from '@/lib/data-url';

type ScanState = 'IDLE' | 'UPLOADING' | 'SCANNING' | 'SUCCESS' | 'FAILED';

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface Failure {
  title: string;
  detail: string;
}

/**
 * What a failed scan tells the user, by the API's error code (never by the
 * HTTP status alone: a 502 is also a refused key, an exhausted quota or a
 * timeout, and none of those is fixed by a better photo).
 */
function scanFailure(err: unknown): Failure {
  const operation = 'Scanning the bill (POST /ocr/scan-bill)';
  switch (getApiErrorCode(err)) {
    case 'OCR_NOT_CONFIGURED':
      return { title: 'OCR is not configured on this server', detail: 'Bill scanning needs a Gemini API key on the API server (GEMINI_API_KEY). Until it is set, store the bill from Smart Capture and enter the lines by hand.' };
    case 'OCR_UNREADABLE_RESPONSE':
      return { title: 'The scanner could not read this document', detail: 'The model answered with something that is not a bill. Try a sharper, better-lit photo with the bill filling the frame.' };
    case 'OCR_MODEL_ERROR': {
      const status = getApiErrorDetails(err)?.status;
      return {
        title: 'The OCR service refused the request',
        detail: `${describeApiError(err, operation)} The photo is not the problem: the server's OCR account (API key, quota or model${typeof status === 'number' ? `, HTTP ${status}` : ''}) refused it. Ask whoever runs the server to check GEMINI_API_KEY and OCR_MODEL.`,
      };
    }
    case 'OCR_TIMEOUT':
    case 'OCR_UNREACHABLE':
      return { title: 'The OCR service did not answer', detail: `${describeApiError(err, operation)} The photo is fine: try again in a minute.` };
    default:
      return { title: 'Scan failed', detail: describeApiError(err, operation) };
  }
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function lineTotal(item: OcrMatchedItem): number | null {
  const unit = item.price ?? item.dbPrice;
  return unit === null ? null : +(unit * item.qty).toFixed(2);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The read lines as a CSV file the user can keep or import elsewhere: a real download, not a fake save. */
function downloadCsv(items: OcrMatchedItem[], fileName: string): void {
  const rows = [
    ['read_name', 'qty', 'read_price', 'matched_sku', 'matched_name', 'catalogue_price', 'confidence', 'line_total'],
    ...items.map((item) => [item.rawName, item.qty, item.price, item.matchedProductSku ?? item.matchedSku, item.matchedName, item.dbPrice, item.confidence.toFixed(2), lineTotal(item)]),
  ];
  const blob = new Blob([rows.map((row) => row.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * AI Invoice Scanner (roadmap 6.1): the image goes to `POST /ocr/scan-bill`
 * and what the page shows is what the API read and matched. A missing OCR
 * configuration (503) or a failed scan is shown as a failure, never as
 * digitised lines; nothing here writes stock or invoices.
 */
export default function AiScannerPage() {
  const [scanState, setScanState] = useState<ScanState>('IDLE');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<OcrScanResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [documentType, setDocumentType] = useState<OcrDocumentType>('BILL');
  const [fileName, setFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const router = useRouter();

  const scan = async (file: Blob, name: string) => {
    setFileName(name);
    setResult(null);
    setFailure(null);
    setProgress(0);
    setScanState('UPLOADING');
    try {
      // A phone photo goes up at the size the model reads (a 50 MP original is past the 10 MiB limit).
      const upload = await photoForUpload(file, OCR_PHOTO_MAX_EDGE);
      const outcome = await ocrApi.scanBill(upload, documentType, (fraction) => {
        setProgress(Math.round(fraction * 100));
        if (fraction >= 1) setScanState('SCANNING');
      });
      setResult(outcome);
      setScanState('SUCCESS');
    } catch (err) {
      setFailure(scanFailure(err));
      setScanState('FAILED');
    }
  };

  // A capture handed over from Smart Capture is scanned once, then forgotten.
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_SCAN_KEY);
      if (pending) sessionStorage.removeItem(PENDING_SCAN_KEY);
    } catch {
      pending = null;
    }
    if (!pending) return;
    try {
      void scan(dataUrlToBlob(pending), 'smart-capture.jpg');
    } catch {
      toast('Could not read the captured photo. Upload it again.', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      toast('Upload a JPEG, PNG or WebP photo of the bill. PDFs are not read.', 'error');
      return;
    }
    void scan(file, file.name);
  };

  const reset = () => {
    setScanState('IDLE');
    setProgress(0);
    setResult(null);
    setFailure(null);
  };

  const matched = result?.preview.matchedItems ?? [];
  const matchedCount = matched.filter((item) => item.matchedSku !== null).length;
  const averageConfidence = matched.length ? Math.round((matched.reduce((sum, item) => sum + item.confidence, 0) / matched.length) * 100) : 0;
  const subtotal = matched.reduce((sum, item) => sum + (lineTotal(item) ?? 0), 0);
  const priced = matched.filter((item) => lineTotal(item) !== null).length;

  return (
    <div className="max-w-[1400px] mx-auto space-y-8 pb-10">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] flex items-center gap-3">
            <ScanLine size={32} className="text-[#7C3AED]" />
            AI Invoice Scanner
          </h1>
          <p className="text-sm text-gray-500 mt-2 font-medium">Read handwritten bills, supplier invoices and kirana notes with Gemini and match the lines to your catalogue.</p>
        </div>
        <div className="bg-purple-50 text-[#7C3AED] border border-purple-100 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm">
          <Sparkles size={16} /> Beta Version
        </div>
      </div>

      <AnimatePresence mode="wait">
        {scanState === 'IDLE' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="grid grid-cols-1 lg:grid-cols-2 gap-8"
          >
            {/* Upload Zone */}
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="relative overflow-hidden group cursor-pointer bg-white rounded-[24px] border-2 border-dashed border-gray-200 hover:border-[#7C3AED] transition-all duration-500 flex flex-col items-center justify-center p-12 min-h-[400px] shadow-[0_4px_20px_rgba(15,23,42,0.04)] hover:shadow-[0_8px_30px_rgba(124,58,237,0.12)]"
            >
              <input 
                type="file" 
                className="hidden" 
                ref={fileInputRef} 
                onChange={handleFileChange}
                accept="image/jpeg,image/png,image/webp"
                data-testid="scan-input"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-purple-50/50 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              
              <div className="w-20 h-20 bg-purple-50 rounded-full flex items-center justify-center text-[#7C3AED] group-hover:scale-110 transition-transform duration-500 mb-6 shadow-sm relative z-10">
                <UploadCloud size={32} />
              </div>
              <h2 className="text-xl font-bold text-gray-800 mb-2 relative z-10">Upload a Bill Photo</h2>
              <p className="text-sm text-gray-500 text-center max-w-xs relative z-10">A JPEG, PNG or WebP photo of a handwritten bill or supplier invoice, or take a picture with Smart Capture.</p>

              <div className="mt-6 relative z-10" onClick={(e) => e.stopPropagation()}>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mr-2">Document</label>
                <select
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value as OcrDocumentType)}
                  className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 outline-none focus:border-[#7C3AED]"
                >
                  <option value="BILL">Bill</option>
                  <option value="INVOICE">Invoice</option>
                  <option value="RECEIPT">Receipt</option>
                  <option value="HANDWRITTEN">Handwritten note</option>
                </select>
              </div>
              
              <div className="flex gap-4 mt-8 relative z-10">
                <button 
                  onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  className="flex items-center gap-2 px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl text-sm font-bold shadow-sm hover:border-gray-300 transition-colors"
                >
                  <FileText size={16} /> Browse Files
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); router.push('/smart-capture'); }}
                  className="flex items-center gap-2 px-5 py-2.5 bg-[#060B26] text-white rounded-xl text-sm font-bold shadow-sm hover:bg-gray-900 transition-colors"
                >
                  <Camera size={16} /> Open Camera
                </button>
              </div>
            </div>

            {/* Info / Capabilities */}
            <div className="bg-gradient-to-br from-[#060B26] to-[#1e1b4b] rounded-[24px] p-10 text-white relative overflow-hidden shadow-xl">
              <div className="absolute top-0 right-0 p-8 opacity-10 blur-2xl">
                <div className="w-64 h-64 bg-[#7C3AED] rounded-full" />
              </div>
              <h3 className="text-2xl font-bold mb-8 flex items-center gap-3">
                <Bot size={28} className="text-[#a78bfa]" />
                Powered by Gemini Vision
              </h3>
              
              <div className="space-y-6 relative z-10">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center backdrop-blur-sm border border-white/10">
                    <Edit3 size={18} className="text-[#a78bfa]" />
                  </div>
                  <div>
                    <h4 className="font-bold text-lg mb-1">Reads Messy Handwriting</h4>
                    <p className="text-gray-400 text-sm leading-relaxed">Understands rough kirana shorthand, cursive, and faded ink.</p>
                  </div>
                </div>
                
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center backdrop-blur-sm border border-white/10">
                    <ScanLine size={18} className="text-[#a78bfa]" />
                  </div>
                  <div>
                    <h4 className="font-bold text-lg mb-1">Smart Product Matching</h4>
                    <p className="text-gray-400 text-sm leading-relaxed">Example: &quot;mggi 140&quot; is matched to &quot;Maggi Noodles 140g&quot; in your catalogue, with a confidence score.</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center backdrop-blur-sm border border-white/10">
                    <Layers size={18} className="text-[#a78bfa]" />
                  </div>
                  <div>
                    <h4 className="font-bold text-lg mb-1">Review Before You Act</h4>
                    <p className="text-gray-400 text-sm leading-relaxed">You get the read lines with their matches and totals to review or export. Stock is changed only through the Products page, never by a scan.</p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {(scanState === 'UPLOADING' || scanState === 'SCANNING') && (
          <motion.div
            key="processing"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center justify-center min-h-[500px] bg-white rounded-[24px] border border-gray-100 shadow-[0_4px_20px_rgba(15,23,42,0.04)] relative overflow-hidden"
          >
            {/* Animated Laser Line */}
            <motion.div 
              animate={{ top: ['0%', '100%', '0%'] }}
              transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
              className="absolute left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#7C3AED] to-transparent shadow-[0_0_15px_#7C3AED] z-20"
            />
            
            <div className="relative mb-8">
              <div className="w-32 h-32 rounded-3xl bg-gray-50 border border-gray-100 flex items-center justify-center relative z-10 overflow-hidden">
                <FileText size={48} className="text-gray-300" />
                <div className="absolute inset-0 bg-purple-500/10 mix-blend-overlay" />
              </div>
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 8, ease: "linear" }}
                className="absolute -inset-4 border border-dashed border-[#7C3AED]/30 rounded-[2rem] z-0"
              />
            </div>

            <h3 className="text-2xl font-bold text-gray-800 mb-2">
              {scanState === 'UPLOADING' && `Uploading ${fileName || 'the photo'}…`}
              {scanState === 'SCANNING' && 'Gemini is reading the document and matching products…'}
            </h3>
            
            <div className="w-64 h-2 bg-gray-100 rounded-full mt-6 overflow-hidden">
              <motion.div 
                className="h-full bg-gradient-to-r from-[#7C3AED] to-[#9333EA]"
                style={{ width: `${scanState === 'SCANNING' ? 100 : progress}%` }}
              />
            </div>
            <p className="text-sm font-bold text-[#7C3AED] mt-3">{scanState === 'SCANNING' ? 'Uploaded, waiting for the model' : `${progress}%`}</p>
          </motion.div>
        )}

        {scanState === 'FAILED' && failure && (
          <motion.div
            key="failed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            data-testid="scan-failure"
            className="bg-red-50 border border-red-200 rounded-2xl p-6 flex items-start justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <XCircle className="text-red-600 mt-0.5 shrink-0" size={24} />
              <div>
                <h3 className="text-red-800 font-bold">{failure.title}</h3>
                <p className="text-red-700 text-sm mt-1">{failure.detail}</p>
              </div>
            </div>
            <button 
              onClick={reset}
              className="px-4 py-2 bg-white text-gray-600 border border-gray-200 rounded-xl text-sm font-bold hover:bg-gray-50 transition-colors shrink-0"
            >
              Try Another
            </button>
          </motion.div>
        )}

        {scanState === 'SUCCESS' && result && (
          <motion.div
            key="success"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-6"
            data-testid="scan-result"
          >
            {/* Top Stats Banner */}
            <div className={`${matched.length ? 'bg-green-50 border-green-200' : 'bg-orange-50 border-orange-200'} border rounded-2xl p-4 flex items-center justify-between`}>
              <div className="flex items-center gap-3">
                {matched.length ? <CheckCircle2 className="text-green-600" size={24} /> : <AlertCircle className="text-orange-600" size={24} />}
                <div>
                  <h3 className={`${matched.length ? 'text-green-800' : 'text-orange-800'} font-bold`}>{matched.length ? 'Document read' : 'No line items found'}</h3>
                  <p className={`${matched.length ? 'text-green-600' : 'text-orange-600'} text-xs`}>
                    {matched.length ? `${matched.length} line${matched.length === 1 ? '' : 's'} read, ${matchedCount} matched to your catalogue, average confidence ${averageConfidence}%.` : result.message}
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={reset}
                  className="px-4 py-2 bg-white text-gray-600 border border-gray-200 rounded-xl text-sm font-bold hover:bg-gray-50 transition-colors"
                >
                  Scan Another
                </button>
                {matched.length > 0 && (
                  <button 
                    onClick={() => downloadCsv(matched, `${(fileName || 'bill').replace(/\.[^.]+$/, '')}-lines.csv`)}
                    className="px-4 py-2 bg-[#060B26] text-white rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-gray-900 transition-colors"
                  >
                    <FileDown size={16} /> Export CSV
                  </button>
                )}
              </div>
            </div>

            {matched.length > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              
              {/* Left Column: OCR matches */}
              <Card className="p-6 rounded-[24px] shadow-[0_4px_20px_rgba(15,23,42,0.04)] border border-gray-100">
                <h2 className="text-lg font-bold text-gray-800 mb-6 flex items-center gap-2">
                  <Sparkles size={20} className="text-[#7C3AED]" /> Read Lines & Matches
                </h2>
                
                <div className="space-y-4">
                  {matched.map((item, index) => {
                    const isMatched = item.matchedSku !== null;
                    const pct = Math.round(item.confidence * 100);
                    return (
                      <div key={`${item.rawName}-${index}`} className={`border rounded-xl p-4 relative overflow-hidden ${isMatched ? 'border-purple-100 bg-purple-50/30' : 'border-orange-200 bg-orange-50/50'}`}>
                        {!isMatched && <div className="absolute top-0 left-0 w-1 h-full bg-orange-400" />}
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">OCR Extracted Text</span>
                            <code className={`text-sm font-mono bg-white px-2 py-1 rounded border ${isMatched ? 'text-purple-900 border-purple-100' : 'text-orange-900 border-orange-100'}`}>
                              &quot;{item.rawName}&quot; - QTY: {item.qty} - {money(item.price)}
                            </code>
                          </div>
                          {isMatched ? (
                            <span className={`text-xs font-bold px-2 py-1 rounded ${pct >= 80 ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>{pct}% Match</span>
                          ) : (
                            <span className="bg-orange-100 text-orange-700 text-xs font-bold px-2 py-1 rounded flex items-center gap-1">
                              <AlertCircle size={12} /> No catalogue match
                            </span>
                          )}
                        </div>
                        <div className={`bg-white border rounded-lg p-3 flex justify-between items-center shadow-sm ${isMatched ? 'border-gray-200' : 'border-orange-200'}`}>
                          <div className="flex items-center gap-3">
                            {isMatched ? <CheckSquare className="text-[#7C3AED]" size={18} /> : <div className="w-5 h-5 border border-gray-300 rounded" />}
                            <div>
                              <p className="font-bold text-gray-800 text-sm">{isMatched ? item.matchedName : 'Not in your catalogue'}</p>
                              <p className="text-xs text-gray-500">{isMatched ? `SKU: ${item.matchedProductSku ?? item.matchedSku}` : 'Add the product on the Products page to match it next time'}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-gray-800 text-sm">{item.qty} × {money(item.price ?? item.dbPrice)} = {money(lineTotal(item))}</p>
                            {isMatched && item.dbPrice !== null && item.price !== null && item.dbPrice !== item.price && (
                              <p className="text-[11px] text-gray-500">Catalogue price {money(item.dbPrice)}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* Right Column: Summary of what was read */}
              <div className="space-y-6">
                <Card className="p-0 rounded-[24px] shadow-[0_4px_20px_rgba(15,23,42,0.04)] border border-gray-100 overflow-hidden bg-[#FAFAFA]">
                  <div className="bg-white p-5 border-b border-gray-100 flex justify-between items-center">
                    <h2 className="font-bold text-gray-800">Bill Summary (as read)</h2>
                    <button 
                      onClick={() => downloadCsv(matched, `${(fileName || 'bill').replace(/\.[^.]+$/, '')}-lines.csv`)}
                      className="text-[#7C3AED] text-sm font-bold flex items-center gap-2 hover:underline"
                    >
                      <FileDown size={16} /> Export CSV
                    </button>
                  </div>
                  
                  <div className="p-8 pb-10">
                    <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200">
                      <div className="flex justify-between border-b border-gray-100 pb-6 mb-6">
                        <div>
                          <h2 className="text-2xl font-black text-gray-800 tracking-tight">{result.documentType}</h2>
                          <p className="text-xs text-gray-400 mt-1">{fileName || 'scanned document'}</p>
                        </div>
                        <div className="text-right text-sm text-gray-500">
                          <p className="font-bold text-gray-800">Read on</p>
                          <p>{new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                        </div>
                      </div>
                      
                      <table className="w-full text-sm text-left mb-6">
                        <thead className="text-xs text-gray-400 border-b border-gray-100">
                          <tr>
                            <th className="pb-3 font-medium">Item Description</th>
                            <th className="pb-3 font-medium text-center">Qty</th>
                            <th className="pb-3 font-medium text-right">Price</th>
                            <th className="pb-3 font-medium text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody className="text-gray-700 divide-y divide-gray-50">
                          {matched.map((item, index) => (
                            <tr key={`${item.rawName}-${index}`}>
                              <td className={`py-3 font-bold ${item.matchedSku === null ? 'text-orange-600' : ''}`}>{item.matchedName ?? item.rawName}</td>
                              <td className="py-3 text-center">{item.qty}</td>
                              <td className="py-3 text-right">{money(item.price ?? item.dbPrice)}</td>
                              <td className="py-3 text-right font-bold">{money(lineTotal(item))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      
                      <div className="border-t border-gray-200 pt-4 flex justify-end">
                        <div className="w-1/2">
                          <div className="flex justify-between text-sm mb-2 text-gray-500">
                            <span>Lines with a price</span>
                            <span>{priced} of {matched.length}</span>
                          </div>
                          <div className="flex justify-between text-lg font-black text-[#7C3AED] border-t border-gray-100 pt-3">
                            <span>Sum of priced lines</span>
                            <span>{money(subtotal)}</span>
                          </div>
                          <p className="text-[11px] text-gray-400 mt-2">Taxes are not read from the document; the sum is of the lines above only.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>

            </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

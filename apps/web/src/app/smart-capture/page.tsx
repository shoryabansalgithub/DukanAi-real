'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { 
  Camera, X, Zap, Image as ImageIcon, ScanLine, FileText, CheckCircle2, 
  User, FolderOpen, ShieldCheck
} from 'lucide-react';
import { customersApi, storageApi, WALK_IN_CUSTOMER, type CustomerView } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { jpegToPdf } from '@/lib/jpeg-pdf';
import { dataUrlToBlob } from '@/lib/data-url';
import { useToast } from '@/components/ui/Toast';
import { useDebounce } from '@/hooks/useDebounce';
import { useSession } from 'next-auth/react';
import { canUsePos, isManagement } from '@/components/customers/permissions';
import { useRouter } from 'next/navigation';
import { JPEG_QUALITY, PENDING_SCAN_KEY, blobToJpegDataUrl, newBillId } from '@/lib/smart-capture';

/** Customers offered per search; the rest are reached by typing more (audit W8: the old list stopped at 25). */
const CUSTOMER_MATCHES = 8;
const WALK_IN_LABEL = 'Walk-in / General Upload';

/**
 * Smart Bill Capture (roadmap 6.1). A photo of a bill, from the camera or the
 * gallery, is stored through `POST /storage/bills/:customerId/:billId` in the
 * shop's document storage: the original JPEG always, plus a PDF rendition
 * built in the browser when asked. Nothing is claimed that the API did not do.
 */
export default function SmartCapturePage() {
  // The customer picker searches the API (`GET /customers?q`): every customer of the shop can be linked.
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [matches, setMatches] = useState<CustomerView[]>([]);
  const [matchTotal, setMatchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const debouncedQuery = useDebounce(customerQuery.trim(), 250);
  const searchSeq = useRef(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedCustomer = selected?.id ?? '';
  const { toast } = useToast();
  const router = useRouter();
  const { data: session } = useSession();
  // The scanner's `POST /ocr/scan-bill` is MANAGEMENT_ROLES (audit W12).
  const allowOcr = isManagement(session?.user?.role);
  /** `POST /storage/bills/...` is POS_ROLES: a VIEWER cannot file a bill. */
  const allowSave = canUsePos(session?.user?.role);
  
  // Camera & Capture State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Bumped by every open and stop: a camera that answers for an older request is stopped at once.
  const cameraRequest = useRef(0);
  const mounted = useRef(true);

  // The newest customers when nothing is typed, else the matches; only the newest answer lands.
  useEffect(() => {
    if (selected) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    customersApi
      .list({ q: debouncedQuery || undefined, take: CUSTOMER_MATCHES })
      .then((page) => {
        if (seq !== searchSeq.current) return;
        setMatches(page.items);
        setMatchTotal(page.total);
      })
      .catch((err) => {
        if (seq !== searchSeq.current) return;
        setMatches([]);
        setMatchTotal(0);
        setSearchError(describeApiError(err, 'Searching customers (GET /customers)'));
      })
      .finally(() => {
        if (seq === searchSeq.current) setSearching(false);
      });
  }, [debouncedQuery, selected]);

  useEffect(() => {
    setHighlight(-1);
  }, [matches]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setListOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const chooseCustomer = (customer: { id: string; name: string } | null) => {
    setSelected(customer);
    setCustomerQuery('');
    setListOpen(false);
  };

  const stopStream = useCallback(() => {
    cameraRequest.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setTorchOn(false);
  }, []);

  // The camera never outlives the page, even when the permission prompt answers after it is gone (audit W18).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopStream();
    };
  }, [stopStream]);

  const openCamera = async () => {
    setIsCameraOpen(true);
    setCapturedImage(null);
    setSuccessMsg('');
    const request = ++cameraRequest.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } 
      });
      if (!mounted.current || request !== cameraRequest.current) {
        // Closed (or left) while the prompt was open: never keep the camera on.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      if (!mounted.current || request !== cameraRequest.current) return;
      console.error('Error accessing camera:', err);
      toast('Camera permission denied or not available. You can pick a photo from the gallery instead.', 'error');
      setIsCameraOpen(true);
    }
  };

  const closeCamera = () => {
    stopStream();
    setIsCameraOpen(false);
    setCapturedImage(null);
  };

  /** The torch is a real constraint on the video track where the device offers one. */
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    if (!track || !capabilities?.torch) {
      toast('This camera has no flash the browser can control.', 'info');
      return;
    }
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as MediaTrackConstraintSet] });
      setTorchOn((on) => !on);
    } catch (err) {
      console.error('Torch toggle failed', err);
      toast('Could not switch the flash.', 'error');
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx && canvas.width > 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        setCapturedImage(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
        // Stop the stream after capture to freeze the frame.
        stopStream();
      } else {
        toast('The camera has not delivered a frame yet. Try again in a moment.', 'error');
      }
    }
  };

  const pickFromGallery = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await blobToJpegDataUrl(file);
      stopStream();
      setSuccessMsg('');
      setIsCameraOpen(true);
      setCapturedImage(dataUrl);
    } catch (err) {
      console.error('Could not read the picked image', err);
      toast('That file is not an image the browser can read.', 'error');
    }
  };

  const customerName = () => selected?.name ?? 'Walk-in / General';

  // Option 0 is the walk-in upload, then the matches.
  const pickerOptions: Array<{ id: string; name: string; phone?: string } | null> = [null, ...matches.map((c) => ({ id: c.id, name: c.name, phone: c.phone }))];
  const onPickerKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setListOpen(true);
      setHighlight((h) => (h + 1) % pickerOptions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setListOpen(true);
      setHighlight((h) => (h <= 0 ? pickerOptions.length - 1 : h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (listOpen && highlight >= 0) chooseCustomer(pickerOptions[highlight]);
    } else if (e.key === 'Escape') {
      setListOpen(false);
    }
  };

  const saveAction = async (action: 'photo' | 'pdf' | 'ocr') => {
    if (!capturedImage) return;

    // OCR: hand the capture to the AI scanner, which calls /ocr/scan-bill.
    if (action === 'ocr') {
      try {
        sessionStorage.setItem(PENDING_SCAN_KEY, capturedImage);
      } catch {
        toast('The photo is too large to hand over to the scanner; save it here and upload it on the scanner page instead.', 'error');
        return;
      }
      closeCamera();
      router.push('/ai-scanner');
      return;
    }

    setIsProcessing(true);
    const billId = newBillId();
    const customerId = selectedCustomer || WALK_IN_CUSTOMER;
    try {
      const image = dataUrlToBlob(capturedImage);
      let pdf: Blob | undefined;
      if (action === 'pdf') {
        pdf = new Blob([jpegToPdf(new Uint8Array(await image.arrayBuffer()))], { type: 'application/pdf' });
      }
      await storageApi.storeCapturedBill(selectedCustomer || null, billId, image, { pdf });
      const where = `${customerName()} › Bills › BILL-${billId}`;
      setSuccessMsg(action === 'pdf' ? `Original photo and PDF stored under ${where}.` : `Original photo stored under ${where}.`);
      toast('Bill stored in the shop document storage', 'success');
      setCapturedImage(null);
      closeCamera();
    } catch (err) {
      toast(describeApiError(err, `Storing the bill (POST /storage/bills/${customerId}/…)`), 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto space-y-8 pb-10">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-gray-800 flex items-center gap-3">
            <Camera size={32} className="text-[#3b82f6]" />
            Smart Bill Capture
          </h1>
          <p className="text-sm text-gray-500 mt-2 font-medium">Use your mobile camera to permanently and securely store handwritten Hindi bills or receipts.</p>
        </div>
      </div>

      {successMsg && (
        <div data-testid="capture-success" className="bg-green-50 border border-green-200 text-green-800 p-4 rounded-2xl flex items-start gap-3 shadow-sm animate-in fade-in slide-in-from-top-4">
          <CheckCircle2 className="text-green-500 mt-0.5" size={20} />
          <div>
            <h4 className="font-bold">Stored</h4>
            <p className="text-sm mt-1">{successMsg}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* Settings & Customer Select */}
        <Card className="p-6 rounded-[24px] border border-gray-100 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
          <h2 className="text-lg font-bold text-gray-800 mb-6 flex items-center gap-2">
            <User size={20} className="text-[#3b82f6]" />
            Link to Customer
          </h2>
          
          <div className="mb-6">
            <label htmlFor="capture-customer" className="block text-sm font-bold text-gray-700 mb-2">Select Customer (Optional)</label>
            <div className="relative" ref={pickerRef}>
              <input
                id="capture-customer"
                type="text"
                role="combobox"
                aria-expanded={listOpen}
                aria-controls="capture-customer-list"
                aria-autocomplete="list"
                autoComplete="off"
                value={selected ? selected.name : customerQuery}
                onChange={(e) => {
                  setSelected(null);
                  setCustomerQuery(e.target.value);
                  setListOpen(true);
                }}
                onFocus={() => setListOpen(true)}
                onClick={() => setListOpen(true)}
                onKeyDown={onPickerKey}
                placeholder={`${WALK_IN_LABEL} — type a name or phone to search`}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#3b82f6]/20 focus:border-[#3b82f6] transition-all"
              />
              {listOpen && (
                <ul
                  id="capture-customer-list"
                  role="listbox"
                  aria-label="Customers"
                  className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-gray-100 bg-white shadow-xl"
                >
                  {pickerOptions.map((option, index) => (
                    <li
                      key={option?.id ?? 'walk-in'}
                      role="option"
                      aria-selected={option ? selected?.id === option.id : selected === null}
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => chooseCustomer(option)}
                      className={`cursor-pointer px-3 py-2 text-sm ${highlight === index ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      {option ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-gray-800 truncate">{option.name}</span>
                          <span className="text-[11px] text-gray-500 shrink-0">{option.phone}</span>
                        </div>
                      ) : (
                        <span className="text-gray-600">{WALK_IN_LABEL}</span>
                      )}
                    </li>
                  ))}
                  {searching && matches.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">Searching…</li>}
                  {!searching && !searchError && matches.length === 0 && debouncedQuery && (
                    <li className="px-3 py-2 text-xs text-gray-500">No customers match &ldquo;{debouncedQuery}&rdquo;.</li>
                  )}
                  {matchTotal > matches.length && (
                    <li className="px-3 py-2 text-[11px] text-gray-400">
                      {matchTotal - matches.length} more {debouncedQuery ? 'match' : 'customers'}: type a name or phone number to narrow the list.
                    </li>
                  )}
                </ul>
              )}
            </div>
            {searchError && (
              <p role="alert" className="mt-1.5 text-[11px] text-red-600 font-medium">{searchError}</p>
            )}
            <p className="text-xs text-gray-500 mt-2">A linked bill is filed under that customer&apos;s folder in the shop document storage.</p>
          </div>

          <div className="space-y-4 pt-4 border-t border-gray-100">
            <h3 className="text-sm font-bold text-gray-800 mb-2">Where a capture goes:</h3>
            <div className="flex items-center gap-3 text-sm text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <FolderOpen size={16} className="text-blue-500"/> Shop document storage › Customers › <span className="font-semibold">{customerName()}</span> › Bills
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <ImageIcon size={16} className="text-green-500"/> Original JPEG always; a PDF rendition when you choose &quot;Convert to PDF&quot;
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <ShieldCheck size={16} className="text-purple-500"/> Only your shop&apos;s signed-in staff can store or read them
            </div>
          </div>
        </Card>

        {/* Big Action Card */}
        <div 
          onClick={openCamera}
          className="bg-gradient-to-br from-[#060B26] to-[#1e1b4b] rounded-[24px] p-10 text-white relative overflow-hidden shadow-xl cursor-pointer hover:shadow-2xl transition-all group flex flex-col items-center justify-center min-h-[400px]"
        >
          <div className="absolute top-0 right-0 p-8 opacity-20 blur-3xl">
            <div className="w-64 h-64 bg-[#3b82f6] rounded-full" />
          </div>
          
          <div className="w-24 h-24 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center text-white group-hover:scale-110 transition-transform duration-500 mb-6 shadow-[0_0_30px_rgba(59,130,246,0.3)] relative z-10 border border-white/20">
            <Camera size={40} />
          </div>
          
          <h2 className="text-3xl font-black mb-3 relative z-10 text-center tracking-tight">Open Mobile Camera</h2>
          <p className="text-gray-400 text-center max-w-sm relative z-10 text-sm leading-relaxed">
            Snap photos of rough notes, Hindi slips, or receipts. The original image is permanently saved as your legal proof.
          </p>

          <div className="mt-8 flex gap-3 relative z-10">
            <span className="bg-white/10 backdrop-blur-md text-xs font-bold px-3 py-1.5 rounded-full border border-white/10">Portrait Auto-Focus</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); galleryInputRef.current?.click(); }}
              className="bg-white/10 backdrop-blur-md text-xs font-bold px-3 py-1.5 rounded-full border border-white/10 hover:bg-white/20 transition-colors"
            >
              Or pick from gallery
            </button>
          </div>
        </div>
      </div>

      <input
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        data-testid="gallery-input"
        onChange={(e) => void pickFromGallery(e)}
      />

      {/* CAMERA MODAL OVERLAY */}
      {isCameraOpen && (
        <div className="fixed inset-0 z-50 bg-black backdrop-blur-md flex flex-col">
          {/* Modal Header */}
          <div className="flex justify-between items-center p-4 md:p-6 bg-gradient-to-b from-black/80 to-transparent absolute top-0 w-full z-20">
            <div>
              <h3 className="text-white font-bold text-lg flex items-center gap-2">
                <Camera size={20} className="text-[#3b82f6]" /> Smart Capture
              </h3>
              {selectedCustomer && <p className="text-gray-400 text-xs mt-1">Linking to: {customerName()}</p>}
            </div>
            <button onClick={closeCamera} aria-label="Close camera" className="w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors">
              <X size={20} />
            </button>
          </div>

          {/* Camera Viewfinder */}
          <div className="flex-1 relative flex items-center justify-center overflow-hidden pt-20 pb-40">
            {!capturedImage ? (
              <>
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  className="w-full h-full object-cover max-w-3xl rounded-2xl shadow-2xl"
                />
                {/* Document Guide Overlay */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-6 md:p-10">
                  <div className="w-full max-w-md h-full max-h-[75vh] border-2 border-[#3b82f6]/50 rounded-xl relative shadow-[0_0_0_9999px_rgba(0,0,0,0.6)]">
                    <div className="absolute -top-1 -left-1 w-8 h-8 border-t-4 border-l-4 border-[#3b82f6] rounded-tl-lg" />
                    <div className="absolute -top-1 -right-1 w-8 h-8 border-t-4 border-r-4 border-[#3b82f6] rounded-tr-lg" />
                    <div className="absolute -bottom-1 -left-1 w-8 h-8 border-b-4 border-l-4 border-[#3b82f6] rounded-bl-lg" />
                    <div className="absolute -bottom-1 -right-1 w-8 h-8 border-b-4 border-r-4 border-[#3b82f6] rounded-br-lg" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <p className="text-white text-sm font-bold bg-black/60 px-5 py-2.5 rounded-full backdrop-blur-md border border-white/10 flex items-center gap-2">
                        <ScanLine size={16}/> Align bill inside frame
                      </p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <img src={capturedImage} alt="Captured Bill" className="w-full h-full object-contain max-w-3xl rounded-2xl shadow-2xl" />
            )}
            <canvas ref={canvasRef} className="hidden" />
          </div>

          {/* Bottom Controls */}
          <div className="bg-[#0a0a0a] border-t border-gray-800 p-6 absolute bottom-0 w-full z-20 rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
            {!capturedImage ? (
              <div className="flex items-center justify-center gap-12 max-w-md mx-auto pb-4">
                <button 
                  onClick={() => void toggleTorch()}
                  aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}
                  className={`w-12 h-12 rounded-full flex items-center justify-center text-white transition-colors ${torchOn ? 'bg-yellow-500/40' : 'bg-white/10 hover:bg-white/20'}`}
                >
                  <Zap size={20} />
                </button>
                <button 
                  onClick={capturePhoto}
                  aria-label="Take photo"
                  className="w-20 h-20 rounded-full border-4 border-white p-1 flex items-center justify-center group"
                >
                  <div className="w-full h-full bg-white rounded-full group-hover:scale-90 transition-transform shadow-[0_0_20px_rgba(255,255,255,0.8)]" />
                </button>
                <button 
                  onClick={() => galleryInputRef.current?.click()}
                  aria-label="Pick from gallery"
                  className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
                >
                  <ImageIcon size={20} />
                </button>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto pb-4">
                {isProcessing ? (
                  <div className="flex flex-col items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white mb-6"></div>
                    <p className="text-white font-bold text-lg">Uploading to the shop document storage…</p>
                    <p className="text-gray-400 text-sm mt-2 flex items-center gap-2"><ShieldCheck size={14}/> Filed under {customerName()} › Bills</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-6 px-2">
                      <button onClick={() => { setCapturedImage(null); void openCamera(); }} className="text-white hover:text-red-400 font-bold text-sm bg-white/10 px-4 py-2 rounded-lg transition-colors">Retake Photo</button>
                      <h4 className="text-white font-bold text-sm bg-[#3b82f6]/20 text-[#3b82f6] px-4 py-2 rounded-lg border border-[#3b82f6]/30">Choose Storage Option</h4>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* Option 1 */}
                      <button onClick={() => void saveAction('photo')} disabled={!allowSave} title={allowSave ? undefined : 'Viewers cannot store bills'} className="bg-gray-900 hover:bg-gray-800 text-white rounded-2xl p-5 flex flex-col items-center justify-center gap-3 border border-gray-700 hover:border-blue-500 transition-all shadow-lg group disabled:opacity-50 disabled:cursor-not-allowed">
                        <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <ImageIcon size={24} className="text-blue-400" />
                        </div>
                        <span className="font-bold text-base">Save Original Photo</span>
                        <span className="text-xs text-gray-400 text-center leading-relaxed">Stores the untouched JPG in the shop document storage. Best for Hindi handwriting.</span>
                      </button>
                      
                      {/* Option 2 */}
                      <button onClick={() => void saveAction('pdf')} disabled={!allowSave} title={allowSave ? undefined : 'Viewers cannot store bills'} className="bg-gray-900 hover:bg-gray-800 text-white rounded-2xl p-5 flex flex-col items-center justify-center gap-3 border border-gray-700 hover:border-red-500 transition-all shadow-lg group disabled:opacity-50 disabled:cursor-not-allowed">
                        <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <FileText size={24} className="text-red-400" />
                        </div>
                        <span className="font-bold text-base">Convert to PDF</span>
                        <span className="text-xs text-gray-400 text-center leading-relaxed">Stores the photo and a printable one-page PDF of it.</span>
                      </button>

                      {/* Option 3 */}
                      <button
                        onClick={() => void saveAction('ocr')}
                        disabled={!allowOcr}
                        title={allowOcr ? undefined : 'Only managers, admins and the owner can scan bills'}
                        className="bg-[#1e1b4b] hover:bg-purple-900 text-white rounded-2xl p-5 flex flex-col items-center justify-center gap-3 border border-[#8B5CF6]/50 shadow-[0_0_20px_rgba(139,92,246,0.15)] hover:shadow-[0_0_30px_rgba(139,92,246,0.3)] transition-all group disabled:opacity-50 disabled:cursor-not-allowed">
                        <div className="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <ScanLine size={24} className="text-[#a78bfa]" />
                        </div>
                        <span className="font-bold text-base">Try OCR Extraction</span>
                        <span className="text-xs text-purple-300 text-center leading-relaxed">Opens the AI scanner with this photo; the photo is not stored until you save it there or here.</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

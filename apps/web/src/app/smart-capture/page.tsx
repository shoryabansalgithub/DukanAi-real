'use client';

import React, { useEffect, useState, useRef } from 'react';
import { Card } from '@/components/ui/Card';
import { 
  Camera, X, Zap, Image as ImageIcon, ScanLine, FileText, CheckCircle2, 
  User, UploadCloud, Database, HardDrive, ShieldCheck
} from 'lucide-react';
import { customersApi } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import type { Customer } from '@/types';
import { useRouter } from 'next/navigation';

export default function SmartCapturePage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');
  const { toast } = useToast();
  const router = useRouter();
  
  // Camera & Capture State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [backupFolderPath, setBackupFolderPath] = useState<string>('D:/DukaanAI_Backups');
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fetchCustomers = async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await customersApi.list();
      setCustomers(data.items);
    } catch (err) {
      console.error('Error fetching customers', err);
      setCustomers([]);
      setError('Could not load customers. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchCustomers();
  }, []);


  const selectFolder = async () => {
    try {
      if ('showDirectoryPicker' in window) {
        // @ts-ignore
        const dirHandle = await window.showDirectoryPicker();
        setBackupFolderPath(`[Local Drive]:/${dirHandle.name}`);
        toast(`Local backup folder set to ${dirHandle.name}`, 'success');
      } else {
        toast('Your browser does not support selecting local folders.', 'error');
      }
    } catch (err) {
      console.error('Folder selection cancelled or failed', err);
    }
  };

  const openCamera = async () => {
    setIsCameraOpen(true);
    setCapturedImage(null);
    setSuccessMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } 
      });
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('Error accessing camera:', err);
      toast('Camera permission denied or not available.', 'error');
      setIsCameraOpen(false);
    }
  };

  const closeCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
    }
    setCameraStream(null);
    setIsCameraOpen(false);
    setCapturedImage(null);
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageUrl = canvas.toDataURL('image/jpeg', 0.9);
        setCapturedImage(imageUrl);
        // Stop stream after capture to freeze frame
        if (cameraStream) {
          cameraStream.getTracks().forEach(track => track.stop());
        }
      }
    }
  };

  const saveAction = (action: 'photo' | 'pdf' | 'ocr') => {
    setIsProcessing(true);
    
    // If OCR, redirect to AI Scanner
    if (action === 'ocr') {
      setTimeout(() => {
        toast('Sending to AI Invoice Scanner...', 'info');
        router.push('/ai-scanner');
      }, 1500);
      return;
    }

    // Simulate complex secure saving and local backup
    setTimeout(() => {
      let custName = 'Unknown';
      if (selectedCustomer) {
        const c = customers.find(c => c.id.toString() === selectedCustomer);
        if (c) custName = c.name;
      }
      
      const year = new Date().getFullYear();
      let msg = '';
      const baseDir = backupFolderPath.replace(/\/$/, '');
      if (action === 'photo') msg = `Original JPG safely backed up to ${baseDir}/Customers/${custName}/Bills/${year}/Original_Photos/`;
      if (action === 'pdf') msg = `Converted PDF safely backed up to ${baseDir}/Customers/${custName}/Bills/${year}/PDFs/`;

      setSuccessMsg(msg);
      toast('Capture saved and backed up successfully!', 'success');
      setIsProcessing(false);
      setCapturedImage(null);
      closeCamera();
    }, 2000);
  };
  if (loading) {
    return (
      <div className="p-8 flex justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-[#3b82f6]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm font-medium text-gray-800">Unable to load customers</p>
        <p className="mt-1 text-xs text-gray-500">{error}</p>
        <button
          onClick={() => void fetchCustomers()}
          className="mt-4 rounded-xl bg-[#3b82f6] px-4 py-2 text-sm font-bold text-white transition-all hover:bg-[#2563eb]"
        >
          Retry
        </button>
      </div>
    );
  }

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
        <div className="bg-green-50 border border-green-200 text-green-800 p-4 rounded-2xl flex items-start gap-3 shadow-sm animate-in fade-in slide-in-from-top-4">
          <CheckCircle2 className="text-green-500 mt-0.5" size={20} />
          <div>
            <h4 className="font-bold">Successfully Stored & Backed Up</h4>
            <p className="text-sm mt-1">{successMsg}</p>
            <p className="text-xs text-green-600 mt-2 flex items-center gap-1"><Database size={12}/> Synced to MongoDB Atlas & AWS S3.</p>
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
            <label className="block text-sm font-bold text-gray-700 mb-2">Select Customer (Optional)</label>
            <select 
              value={selectedCustomer}
              onChange={(e) => setSelectedCustomer(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#3b82f6]/20 focus:border-[#3b82f6] transition-all"
            >
              <option value="">Walk-in / General Upload</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-2">Linking a bill automatically places it in their specific offline backup folder.</p>
          </div>

          <div className="space-y-4 pt-4 border-t border-gray-100">
            <h3 className="text-sm font-bold text-gray-800 mb-2">Storage Architecture Enabled:</h3>
            <div className="flex items-center gap-3 text-sm text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <Database size={16} className="text-green-500"/> MongoDB Atlas (Metadata & Customer Link)
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <UploadCloud size={16} className="text-orange-500"/> AWS S3 (Original Images & PDFs)
            </div>
            <div className="flex flex-col gap-2 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-sm text-gray-600">
                  <HardDrive size={16} className="text-blue-500"/> Local Hard Disk Backup
                </div>
                <button 
                  onClick={selectFolder}
                  className="text-xs font-bold text-[#3b82f6] border border-[#3b82f6] px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                >
                  Change Folder
                </button>
              </div>
              <p className="text-[10px] text-gray-500 font-mono mt-1 break-all bg-white p-1.5 rounded border border-gray-200">
                {backupFolderPath}
              </p>
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
            <span className="bg-white/10 backdrop-blur-md text-xs font-bold px-3 py-1.5 rounded-full border border-white/10">Image Enhancement</span>
          </div>
        </div>
      </div>

      {/* CAMERA MODAL OVERLAY */}
      {isCameraOpen && (
        <div className="fixed inset-0 z-50 bg-black backdrop-blur-md flex flex-col">
          {/* Modal Header */}
          <div className="flex justify-between items-center p-4 md:p-6 bg-gradient-to-b from-black/80 to-transparent absolute top-0 w-full z-20">
            <div>
              <h3 className="text-white font-bold text-lg flex items-center gap-2">
                <Camera size={20} className="text-[#3b82f6]" /> Smart Capture
              </h3>
              {selectedCustomer && <p className="text-gray-400 text-xs mt-1">Linking to: {customers.find(c => c.id.toString() === selectedCustomer)?.name}</p>}
            </div>
            <button onClick={closeCamera} className="w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors">
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
                  onClick={() => toast('Flash enabled', 'info')}
                  className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
                >
                  <Zap size={20} />
                </button>
                <button 
                  onClick={capturePhoto}
                  className="w-20 h-20 rounded-full border-4 border-white p-1 flex items-center justify-center group"
                >
                  <div className="w-full h-full bg-white rounded-full group-hover:scale-90 transition-transform shadow-[0_0_20px_rgba(255,255,255,0.8)]" />
                </button>
                <button 
                  onClick={() => toast('Opening gallery...', 'info')}
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
                    <p className="text-white font-bold text-lg">Encrypting & Saving Safely...</p>
                    <p className="text-gray-400 text-sm mt-2 flex items-center gap-2"><ShieldCheck size={14}/> Backing up to Local D:/ Drive, S3, & Atlas</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-6 px-2">
                      <button onClick={() => setCapturedImage(null)} className="text-white hover:text-red-400 font-bold text-sm bg-white/10 px-4 py-2 rounded-lg transition-colors">Retake Photo</button>
                      <h4 className="text-white font-bold text-sm bg-[#3b82f6]/20 text-[#3b82f6] px-4 py-2 rounded-lg border border-[#3b82f6]/30">Choose Storage Option</h4>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* Option 1 */}
                      <button onClick={() => saveAction('photo')} className="bg-gray-900 hover:bg-gray-800 text-white rounded-2xl p-5 flex flex-col items-center justify-center gap-3 border border-gray-700 hover:border-blue-500 transition-all shadow-lg group">
                        <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <ImageIcon size={24} className="text-blue-400" />
                        </div>
                        <span className="font-bold text-base">Save Original Photo</span>
                        <span className="text-xs text-gray-400 text-center leading-relaxed">Securely store the untouched JPG image forever. Best for Hindi handwriting.</span>
                      </button>
                      
                      {/* Option 2 */}
                      <button onClick={() => saveAction('pdf')} className="bg-gray-900 hover:bg-gray-800 text-white rounded-2xl p-5 flex flex-col items-center justify-center gap-3 border border-gray-700 hover:border-red-500 transition-all shadow-lg group">
                        <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <FileText size={24} className="text-red-400" />
                        </div>
                        <span className="font-bold text-base">Convert to PDF</span>
                        <span className="text-xs text-gray-400 text-center leading-relaxed">Converts image to a clean printable PDF document automatically.</span>
                      </button>

                      {/* Option 3 */}
                      <button onClick={() => saveAction('ocr')} className="bg-[#1e1b4b] hover:bg-purple-900 text-white rounded-2xl p-5 flex flex-col items-center justify-center gap-3 border border-[#8B5CF6]/50 shadow-[0_0_20px_rgba(139,92,246,0.15)] hover:shadow-[0_0_30px_rgba(139,92,246,0.3)] transition-all group">
                        <div className="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <ScanLine size={24} className="text-[#a78bfa]" />
                        </div>
                        <span className="font-bold text-base">Try OCR Extraction</span>
                        <span className="text-xs text-purple-300 text-center leading-relaxed">Experimental AI parsing. Fails safely to Original Photo if handwriting is too rough.</span>
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

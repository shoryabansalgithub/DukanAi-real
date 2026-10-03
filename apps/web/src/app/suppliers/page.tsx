'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Card } from '@/components/ui/Card';
import { 
  Plus, Search, Filter, MoreVertical, 
  Building2, Wallet, ChevronDown, CheckCircle2, Box
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SlidingPanel } from '@/components/ui/SlidingPanel';
import { useToast } from '@/components/ui/Toast';
import { AnimatePresence, motion } from 'framer-motion';
import { useSession } from 'next-auth/react';
import { suppliersApi, type SupplierView } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { AUTH_DISABLED } from '@/lib/auth-bypass';
import type { TenderType } from '@/types';

/** `PATCH /suppliers/:id` is MANAGER and above, `DELETE /suppliers/:id` OWNER/ADMIN (contract). */
const EDIT_ROLES = new Set(['MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN']);
const DELETE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPER_ADMIN']);
const hasRole = (roles: Set<string>, role: string | null | undefined) => AUTH_DISABLED || (!!role && roles.has(role.toUpperCase()));

const PAYMENT_MODES: Array<{ label: string; tender: TenderType }> = [
  { label: 'Bank Transfer (NEFT/RTGS)', tender: 'BANK_TRANSFER' },
  { label: 'UPI', tender: 'UPI' },
  { label: 'Cash', tender: 'CASH' },
  { label: 'Card', tender: 'CARD' },
];

export default function SuppliersPage() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const allowEdit = hasRole(EDIT_ROLES, session?.user?.role);
  const allowDelete = hasRole(DELETE_ROLES, session?.user?.role);
  const [suppliers, setSuppliers] = useState<SupplierView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    suppliersApi.list()
      .then(setSuppliers)
      .catch((err) => {
        setSuppliers([]);
        toast(describeApiError(err, 'Loading suppliers (GET /suppliers)'), 'error');
      })
      .finally(() => setLoading(false));
  }, [toast]);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modals & Panels
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SupplierView | null>(null);
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierView | null>(null);
  const [activeTab, setActiveTab] = useState('Details');
  const [saving, setSaving] = useState(false);

  // Dropdowns
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  
  const filterRef = useRef<HTMLDivElement>(null);

  // Filters & Sorting
  const [statusFilter, setStatusFilter] = useState('All');
  const [payableFilter, setPayableFilter] = useState('All');

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Form State
  const [newName, setNewName] = useState('');
  const [newContact, setNewContact] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newOpeningBalance, setNewOpeningBalance] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentTender, setPaymentTender] = useState<TenderType>('BANK_TRANSFER');

  // Form State - Edit
  const [editName, setEditName] = useState('');
  const [editContact, setEditContact] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editGstin, setEditGstin] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editActive, setEditActive] = useState(true);

  const openEdit = (supplier: SupplierView) => {
    setEditName(supplier.name);
    setEditContact(supplier.contactPerson);
    setEditPhone(supplier.phone);
    setEditEmail(supplier.email ?? '');
    setEditGstin(supplier.gstin ?? '');
    setEditAddress(supplier.address ?? '');
    setEditActive(supplier.status === 'Active');
    setIsEditModalOpen(true);
  };

  // Derived Stats
  const totalSuppliers = suppliers.length;
  const activeSuppliers = suppliers.filter(s => s.status === 'Active').length;
  const totalPayables = suppliers.reduce((acc, curr) => acc + curr.pendingPayables, 0);

  // Filter Logic
  let processedSuppliers = suppliers.filter(s => 
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    s.contactPerson.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.phone.includes(searchTerm)
  );

  if (statusFilter !== 'All') {
    processedSuppliers = processedSuppliers.filter(s => s.status === statusFilter);
  }

  if (payableFilter !== 'All') {
    if (payableFilter === 'Has Dues') processedSuppliers = processedSuppliers.filter(s => s.pendingPayables > 0);
    if (payableFilter === 'Settled') processedSuppliers = processedSuppliers.filter(s => s.pendingPayables === 0);
  }

  const handleSaveSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPhone.trim()) return;

    try {
      const created = await suppliersApi.create({
        name: newName.trim(),
        phone: newPhone.trim(),
        contactPerson: newContact.trim() || undefined,
        openingBalance: Number(newOpeningBalance) || 0,
      });

      setSuppliers([created, ...suppliers]);
      toast('Supplier added successfully', 'success');
      setIsAddModalOpen(false);

      setNewName(''); setNewContact(''); setNewPhone(''); setNewOpeningBalance('');
    } catch (err) {
      toast(describeApiError(err, 'Saving supplier (POST /suppliers)'), 'error');
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplier || !paymentAmount || Number(paymentAmount) <= 0) return;

    try {
      const updated = await suppliersApi.recordPayment(selectedSupplier.id, Number(paymentAmount), paymentTender);

      setSuppliers(suppliers.map(s => (s.id === updated.id ? updated : s)));
      toast(`₹${paymentAmount} paid to ${selectedSupplier.name}`, 'success');
      setIsPaymentModalOpen(false);
      setPaymentAmount('');

      // Update local selected supplier state to reflect in side panel instantly
      setSelectedSupplier(updated);
    } catch (err) {
      toast(describeApiError(err, 'Recording supplier payment (POST /suppliers/:id/payments)'), 'error');
    }
  };

  /** `PATCH /suppliers/:id`: only the fields the form holds, blanks clear the optional ones. */
  const handleEditSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplier || !editName.trim() || !editPhone.trim()) return;
    setSaving(true);
    try {
      const updated = await suppliersApi.update(selectedSupplier.id, {
        name: editName.trim(),
        phone: editPhone.trim(),
        contactPerson: editContact.trim(),
        email: editEmail.trim(),
        gstin: editGstin.trim(),
        address: editAddress.trim(),
        isActive: editActive,
      });
      setSuppliers((rows) => rows.map((s) => (s.id === updated.id ? updated : s)));
      setSelectedSupplier(updated);
      toast(`${updated.name} updated`, 'success');
      setIsEditModalOpen(false);
    } catch (err) {
      toast(describeApiError(err, 'Updating supplier (PATCH /suppliers/:id)'), 'error');
    } finally {
      setSaving(false);
    }
  };

  /** `DELETE /suppliers/:id` after an explicit confirmation; the row leaves the list only once the API agreed. */
  const handleDeleteSupplier = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setSaving(true);
    try {
      await suppliersApi.delete(target.id);
      setSuppliers((rows) => rows.filter((s) => s.id !== target.id));
      if (selectedSupplier?.id === target.id) { setSelectedSupplier(null); setIsSidePanelOpen(false); }
      toast(`${target.name} deleted`, 'success');
      setPendingDelete(null);
    } catch (err) {
      toast(describeApiError(err, 'Deleting supplier (DELETE /suppliers/:id)'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleAction = (action: string, supplier: SupplierView, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenActionMenuId(null);
    setSelectedSupplier(supplier);
    
    switch (action) {
      case 'View Details': 
        setIsSidePanelOpen(true);
        break;
      case 'Pay Supplier':
        setIsPaymentModalOpen(true);
        break;
      case 'Record Purchase':
        // Purchases are recorded through purchase orders and goods receipts, which this app does not expose yet.
        toast('Purchase orders are not available in this app yet; record a payment or adjust stock from the Products page.', 'info');
        break;
      case 'Edit Supplier':
        openEdit(supplier);
        break;
      case 'Delete':
        setPendingDelete(supplier);
        break;
    }
  };
  if (loading) return <div className="p-12 text-center text-gray-500">Loading suppliers...</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Suppliers & Vendors</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your distributors, track payables, and record purchases.</p>
        </div>
        {allowEdit && (
          <button 
            onClick={() => setIsAddModalOpen(true)}
            className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-purple-500/30 transition-all"
          >
            <Plus size={18} />
            Add Supplier
          </button>
        )}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center text-[#8B5CF6]">
            <Building2 size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Total Suppliers</p>
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">{totalSuppliers}</h3>
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center text-green-500">
            <CheckCircle2 size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Active Partners</p>
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">{activeSuppliers}</h3>
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500">
            <Wallet size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Total Pending Payables</p>
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">₹{totalPayables.toLocaleString('en-IN')}</h3>
          </div>
        </Card>
      </div>

      {/* Main Content Card */}
      <Card className="p-0 overflow-visible">
        {/* Toolbar */}
        <div className="p-5 border-b border-gray-100 flex flex-col sm:flex-row gap-4 justify-between items-center bg-gray-50/50">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input 
              type="text" 
              placeholder="Search by supplier name, contact, or phone..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6] transition-all"
            />
          </div>
          <div className="relative" ref={filterRef}>
            <button 
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors w-full sm:w-auto justify-center"
            >
              <Filter size={16} />
              Filters <ChevronDown size={14} />
            </button>

            <AnimatePresence>
              {isFilterOpen && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute right-0 top-full mt-2 w-64 bg-white border border-gray-100 shadow-xl rounded-xl z-20 p-4"
                >
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Status</h4>
                      <div className="flex flex-wrap gap-2">
                        {['All', 'Active', 'Inactive'].map(s => (
                          <button 
                            key={s} 
                            onClick={() => setStatusFilter(s)}
                            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${statusFilter === s ? 'bg-[#8B5CF6] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Payables</h4>
                      <div className="flex flex-wrap gap-2">
                        {['All', 'Has Dues', 'Settled'].map(s => (
                          <button 
                            key={s} 
                            onClick={() => setPayableFilter(s)}
                            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${payableFilter === s ? 'bg-[#8B5CF6] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto min-h-[400px]">
          <table className="w-full text-left text-sm text-gray-600">
            <thead className="bg-gray-50/80 text-gray-500 text-xs uppercase font-semibold border-b border-gray-100">
              <tr>
                <th className="px-6 py-4">Supplier / Vendor</th>
                <th className="px-6 py-4">Contact Info</th>
                <th className="px-6 py-4">Pending Payables</th>
                <th className="px-6 py-4">Last Delivery</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {processedSuppliers.map((supplier) => (
                <tr 
                  key={supplier.id} 
                  onClick={() => { setSelectedSupplier(supplier); setIsSidePanelOpen(true); }}
                  className="hover:bg-gray-50/50 transition-colors cursor-pointer group"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-500">
                        <Building2 size={20} />
                      </div>
                      <span className="font-bold text-gray-800">{supplier.name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="font-medium text-gray-800 block">{supplier.contactPerson}</span>
                    <span className="text-xs text-gray-500 mt-0.5 block">{supplier.phone}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`font-bold ${supplier.pendingPayables > 0 ? 'text-red-500' : 'text-green-500'}`}>
                      ₹{supplier.pendingPayables.toLocaleString('en-IN')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-500 font-medium">
                    {supplier.lastDelivery ? new Date(supplier.lastDelivery).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '-'}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                      supplier.status === 'Active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {supplier.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right relative">
                    <button 
                      aria-label={`Actions for ${supplier.name}`}
                      onClick={(e) => { e.stopPropagation(); setOpenActionMenuId(openActionMenuId === supplier.id ? null : supplier.id); }}
                      className="p-2 text-gray-400 hover:text-[#8B5CF6] transition-colors rounded-lg hover:bg-[#8B5CF6]/10"
                    >
                      <MoreVertical size={18} />
                    </button>

                    <AnimatePresence>
                      {openActionMenuId === supplier.id && (
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="absolute right-8 top-10 w-48 bg-white border border-gray-100 shadow-xl rounded-xl z-50 overflow-hidden text-left"
                        >
                          {['View Details', 'Pay Supplier', 'Record Purchase', ...(allowEdit ? ['Edit Supplier'] : [])].map(action => (
                            <button 
                              key={action}
                              onClick={(e) => handleAction(action, supplier, e)}
                              className="w-full text-left px-4 py-2.5 text-xs text-gray-700 hover:bg-gray-50 font-medium transition-colors"
                            >
                              {action}
                            </button>
                          ))}
                          {allowDelete && (
                            <>
                              <div className="h-px bg-gray-100 w-full" />
                              <button 
                                onClick={(e) => handleAction('Delete', supplier, e)}
                                className="w-full text-left px-4 py-2.5 text-xs text-red-600 hover:bg-red-50 font-bold transition-colors"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </td>
                </tr>
              ))}
              {processedSuppliers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                    <Building2 className="mx-auto h-12 w-12 text-gray-300 mb-3" />
                    <p className="font-medium text-gray-800">No suppliers found</p>
                    <p className="text-xs mt-1">Try adjusting your filters or search.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add Supplier Modal */}
      <Modal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} title="Add New Supplier" size="md">
        <form onSubmit={handleSaveSupplier} className="space-y-4">
          <div><label className="text-sm font-medium">Business / Supplier Name *</label><input value={newName} onChange={e=>setNewName(e.target.value)} required className="w-full mt-1 border rounded-lg p-2" placeholder="e.g. Delhi Wholesale Mart" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="text-sm font-medium">Contact Person</label><input value={newContact} onChange={e=>setNewContact(e.target.value)} className="w-full mt-1 border rounded-lg p-2" placeholder="e.g. Rajeev" /></div>
            <div><label className="text-sm font-medium">Phone Number *</label><input value={newPhone} onChange={e=>setNewPhone(e.target.value)} required pattern="[0-9]{10}" maxLength={10} className="w-full mt-1 border rounded-lg p-2" placeholder="10-digit number" /></div>
          </div>
          <div><label className="text-sm font-medium">Opening Balance (Payable ₹)</label><input value={newOpeningBalance} onChange={e=>setNewOpeningBalance(e.target.value)} type="number" className="w-full mt-1 border rounded-lg p-2" placeholder="0" /></div>
          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" onClick={() => setIsAddModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold shadow-lg shadow-purple-500/30">Save Supplier</button>
          </div>
        </form>
      </Modal>

      {/* Record Payment Modal */}
      <Modal isOpen={isPaymentModalOpen} onClose={() => setIsPaymentModalOpen(false)} title={`Pay Supplier: ${selectedSupplier?.name}`} size="sm">
        <form onSubmit={handleRecordPayment} className="space-y-4">
          <div className="bg-red-50 text-red-600 p-3 rounded-xl border border-red-100 flex items-center justify-between">
            <span className="text-xs font-bold uppercase">Pending Amount</span>
            <span className="font-black text-lg">₹{selectedSupplier?.pendingPayables.toLocaleString('en-IN')}</span>
          </div>
          <div>
            <label className="text-sm font-medium">Amount to Pay (₹) *</label>
            <input 
              value={paymentAmount} 
              onChange={e=>setPaymentAmount(e.target.value)} 
              type="number" 
              required 
              max={selectedSupplier?.pendingPayables || undefined}
              className="w-full mt-1 border rounded-lg p-3 text-lg font-bold" 
              placeholder="0" 
            />
          </div>
          <div>
            <label className="text-sm font-medium">Payment Mode</label>
            <select value={paymentTender} onChange={(e) => setPaymentTender(e.target.value as TenderType)} className="w-full mt-1 border rounded-lg p-2">
              {PAYMENT_MODES.map((mode) => <option key={mode.tender} value={mode.tender}>{mode.label}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1">Cash is taken from the drawer; every other mode is paid from the bank account.</p>
          </div>
          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" onClick={() => setIsPaymentModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-bold shadow-lg shadow-green-500/30">Confirm Payment</button>
          </div>
        </form>
      </Modal>

      {/* Edit Supplier Modal */}
      <Modal isOpen={isEditModalOpen} onClose={() => setIsEditModalOpen(false)} title={`Edit Supplier: ${selectedSupplier?.name ?? ''}`} size="md">
        <form onSubmit={handleEditSupplier} className="space-y-4">
          <div><label className="text-sm font-medium">Business / Supplier Name *</label><input value={editName} onChange={e=>setEditName(e.target.value)} required className="w-full mt-1 border rounded-lg p-2" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="text-sm font-medium">Contact Person</label><input value={editContact} onChange={e=>setEditContact(e.target.value)} className="w-full mt-1 border rounded-lg p-2" /></div>
            <div><label className="text-sm font-medium">Phone Number *</label><input value={editPhone} onChange={e=>setEditPhone(e.target.value)} required pattern="[0-9]{10}" maxLength={10} className="w-full mt-1 border rounded-lg p-2" /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="text-sm font-medium">Email</label><input value={editEmail} onChange={e=>setEditEmail(e.target.value)} type="email" className="w-full mt-1 border rounded-lg p-2" /></div>
            <div><label className="text-sm font-medium">GSTIN</label><input value={editGstin} onChange={e=>setEditGstin(e.target.value)} className="w-full mt-1 border rounded-lg p-2" /></div>
          </div>
          <div><label className="text-sm font-medium">Address</label><input value={editAddress} onChange={e=>setEditAddress(e.target.value)} className="w-full mt-1 border rounded-lg p-2" /></div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} /> Active partner
          </label>
          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" onClick={() => setIsEditModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold shadow-lg shadow-purple-500/30 disabled:opacity-60">{saving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal isOpen={pendingDelete !== null} onClose={() => setPendingDelete(null)} title="Delete Supplier" size="sm">
        {pendingDelete && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700"><span className="font-bold">{pendingDelete.name}</span> will be removed from your supplier list. Its purchase history and payables stay on record.</p>
            <div className="flex justify-end gap-2 pt-4 border-t">
              <button type="button" onClick={() => setPendingDelete(null)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
              <button type="button" disabled={saving} onClick={() => void handleDeleteSupplier()} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-bold shadow-lg shadow-red-500/30 disabled:opacity-60">{saving ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Side Panel for Details */}
      <SlidingPanel isOpen={isSidePanelOpen} onClose={() => setIsSidePanelOpen(false)} title="Supplier Details">
        {selectedSupplier && (
          <div className="p-6">
            <div className="flex items-center gap-4 mb-8">
              <div className="w-16 h-16 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-500">
                <Building2 size={32} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-800">{selectedSupplier.name}</h2>
                <p className="text-sm text-gray-500 mt-0.5">{selectedSupplier.contactPerson} • {selectedSupplier.phone}</p>
                <div className="mt-2 flex gap-2">
                   <span className={`px-2 py-0.5 rounded text-xs font-bold ${selectedSupplier.status === 'Active' ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-600'}`}>
                     {selectedSupplier.status}
                   </span>
                </div>
              </div>
            </div>

            <div className="flex gap-4 border-b border-gray-100 mb-6">
              {['Details', 'Recent Purchases'].map(tab => (
                <button 
                  key={tab} 
                  onClick={() => setActiveTab(tab)}
                  className={`pb-2 text-sm font-bold border-b-2 transition-colors ${activeTab === tab ? 'border-[#8B5CF6] text-[#8B5CF6]' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {activeTab === 'Details' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-red-50 p-4 rounded-xl border border-red-100 col-span-2 flex items-center justify-between">
                    <div>
                      <p className="text-xs text-red-500 mb-1 font-bold uppercase tracking-wider">Pending Payables</p>
                      <p className="font-black text-red-600 text-2xl">₹{selectedSupplier.pendingPayables.toLocaleString('en-IN')}</p>
                    </div>
                    {selectedSupplier.pendingPayables > 0 && (
                      <button 
                        onClick={() => { setIsSidePanelOpen(false); setIsPaymentModalOpen(true); }}
                        className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-bold shadow-md hover:bg-red-700 transition-colors"
                      >
                        Pay Now
                      </button>
                    )}
                  </div>
                  
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-xs text-gray-500 mb-1">Last Delivery</p>
                    <p className="font-bold text-gray-800">
                      {selectedSupplier.lastDelivery ? new Date(selectedSupplier.lastDelivery).toLocaleDateString('en-IN') : '-'}
                    </p>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-xs text-gray-500 mb-1">Total Purchases (YTD)</p>
                    <p className="font-bold text-gray-800">—</p>
                  </div>
                </div>
                
                {allowEdit && (
                  <button 
                    onClick={() => { setIsSidePanelOpen(false); openEdit(selectedSupplier); }}
                    className="w-full mt-4 bg-purple-50 text-[#8B5CF6] hover:bg-purple-100 py-3 rounded-xl text-sm font-bold transition-colors border border-purple-200 flex items-center justify-center gap-2"
                  >
                    <Box size={16} /> Edit Supplier Details
                  </button>
                )}
              </div>
            )}

            {activeTab === 'Recent Purchases' && (
              <div className="p-6 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl">
                No purchase orders recorded for this supplier yet.
              </div>
            )}
          </div>
        )}
      </SlidingPanel>
    </div>
  );
}

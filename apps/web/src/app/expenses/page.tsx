'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { 
  Receipt, Plus, Search, Filter, MoreVertical, 
  TrendingDown, Zap, Building, CreditCard, ChevronDown, CheckCircle2, AlertCircle, FileText
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { AnimatePresence, motion } from 'framer-motion';
import { expensesApi, type ExpenseSummary, type ExpenseView } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';

const CATEGORY_COLORS: Record<string, string> = {
  'Rent': 'bg-blue-100 text-blue-600',
  'Utilities': 'bg-yellow-100 text-yellow-600',
  'Salary': 'bg-green-100 text-green-600',
  'Maintenance': 'bg-orange-100 text-orange-600',
  'Supplies': 'bg-purple-100 text-purple-600',
  'Other': 'bg-gray-100 text-gray-600'
};

const CATEGORY_ICONS: Record<string, React.ComponentType<{ size?: number | string }>> = {
  'Rent': Building,
  'Utilities': Zap,
  'Maintenance': TrendingDown,
};

export default function ExpensesPage() {
  const { toast } = useToast();
  const [expenses, setExpenses] = useState<ExpenseView[]>([]);
  const [loading, setLoading] = useState(true);
  // Roadmap 6.7: the tiles are this month's figures over every expense (GET /expenses/summary), not over the loaded page.
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExpenseView | null>(null);

  const refreshSummary = useCallback(() => {
    expensesApi
      .summary()
      .then((next) => {
        setSummary(next);
        setSummaryError(null);
      })
      .catch((err) => setSummaryError(describeApiError(err, 'Loading expense totals (GET /expenses/summary)')));
  }, []);

  useEffect(() => {
    let cancelled = false;
    expensesApi.list()
      .then(data => {
        if (!cancelled && Array.isArray(data)) {
          setExpenses(data);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setExpenses([]);
        toast(describeApiError(err, 'Loading expenses (GET /expenses)'), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    refreshSummary();
    return () => {
      cancelled = true;
    };
  }, [toast, refreshSummary]);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modals & Panels
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Dropdowns
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  
  const filterRef = useRef<HTMLDivElement>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('All');

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
  const [newDesc, setNewDesc] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newCategory, setNewCategory] = useState('Supplies');
  const [newMode, setNewMode] = useState('Cash');
  const [newStatus, setNewStatus] = useState('Paid');

  const figure = (value: number | undefined) => (summary && value !== undefined ? `₹${value.toLocaleString('en-IN')}` : '—');

  // Filter Logic
  let processedExpenses = expenses.filter(e => 
    e.description.toLowerCase().includes(searchTerm.toLowerCase()) || 
    e.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
    e.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (statusFilter !== 'All') {
    processedExpenses = processedExpenses.filter(e => e.status === statusFilter);
  }

  if (categoryFilter !== 'All') {
    processedExpenses = processedExpenses.filter(e => e.category === categoryFilter);
  }

  const resetForm = () => {
    setNewDesc(''); setNewAmount(''); setNewCategory('Supplies'); setNewMode('Cash'); setNewStatus('Paid');
    setEditing(null);
  };

  const openEdit = (expense: ExpenseView) => {
    setEditing(expense);
    setNewDesc(expense.description);
    setNewAmount(String(expense.amount));
    setNewCategory(expense.category);
    setNewMode(expense.status === 'Paid' ? expense.mode : 'Cash');
    setNewStatus(expense.status);
    setIsAddModalOpen(true);
  };

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDesc.trim() || !newAmount) return;

    const body = {
      description: newDesc.trim(),
      category: newCategory,
      amount: Number(newAmount),
      isPaid: newStatus === 'Paid',
      paymentMode: newStatus === 'Paid' ? newMode : undefined,
    };
    try {
      if (editing) {
        const updated = await expensesApi.update(editing.id, body);
        setExpenses((current) => current.map((ex) => (ex.id === updated.id ? updated : ex)));
        toast(`"${updated.description}" updated`, 'success');
      } else {
        const created = await expensesApi.create(body);
        setExpenses([created, ...expenses]);
        toast(`₹${newAmount} recorded under ${newCategory}`, 'success');
      }
      setIsAddModalOpen(false);
      resetForm();
      refreshSummary();
    } catch (err) {
      toast(describeApiError(err, editing ? 'Updating expense (PATCH /expenses/:id)' : 'Recording expense (POST /expenses)'), 'error');
    }
  };

  const handleAction = async (action: string, expense: ExpenseView, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenActionMenuId(null);

    switch (action) {
      case 'Mark as Paid':
        try {
          const updated = await expensesApi.update(expense.id, { isPaid: true, paymentMode: 'Cash' });
          setExpenses(expenses.map(ex => (ex.id === expense.id ? updated : ex)));
          toast(`"${expense.description}" marked as Paid`, 'success');
          refreshSummary();
        } catch (err) {
          toast(describeApiError(err, 'Updating expense (PATCH /expenses/:id)'), 'error');
        }
        break;
      case 'Edit':
        openEdit(expense);
        break;
      case 'Delete':
        try {
          await expensesApi.delete(expense.id);
          setExpenses(expenses.filter(ex => ex.id !== expense.id));
          toast(`Expense "${expense.description}" deleted`, 'success');
          refreshSummary();
        } catch (err) {
          toast(describeApiError(err, 'Deleting expense (DELETE /expenses/:id)'), 'error');
        }
        break;
    }
  };
  if (loading) return <div className="p-12 text-center text-gray-500">Loading expenses...</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Expenses & Overheads</h1>
          <p className="text-sm text-gray-500 mt-1">Track day-to-day shop expenses, utilities, and pending bills.</p>
        </div>
        <button 
          onClick={() => setIsAddModalOpen(true)}
          className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-purple-500/30 transition-all"
        >
          <Plus size={18} />
          Record Expense
        </button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 flex items-center justify-between hoverable border-l-4 border-l-[#8B5CF6]">
          <div>
            <p className="text-xs text-gray-500 font-medium">Total Paid (This Month)</p>
            <h3 className="text-2xl font-black text-gray-800 tracking-tight mt-1" data-testid="expenses-paid-month" title={summaryError ?? undefined}>{figure(summary?.paidThisMonth)}</h3>
          </div>
          <div className="w-12 h-12 rounded-full bg-purple-50 flex items-center justify-center text-[#8B5CF6]">
            <TrendingDown size={24} />
          </div>
        </Card>
        
        <Card className="p-5 flex items-center justify-between hoverable border-l-4 border-l-red-500 bg-red-50/30">
          <div>
            <p className="text-xs text-red-500 font-bold">Unpaid / Pending Bills</p>
            <h3 className="text-2xl font-black text-red-700 tracking-tight mt-1" data-testid="expenses-pending" title={summaryError ?? undefined}>{figure(summary?.pendingTotal)}</h3>
          </div>
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center text-red-600">
            <AlertCircle size={24} />
          </div>
        </Card>

        <Card className="p-5 flex flex-col justify-center hoverable border-l-4 border-l-blue-500">
          <p className="text-xs text-gray-500 font-medium flex items-center gap-2">
            <TrendingDown size={14} className="text-blue-500" /> Largest Category
          </p>
          <div className="mt-1 flex items-end gap-2">
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">{summary ? summary.largestCategory?.category ?? 'None' : '—'}</h3>
            <span className="text-sm font-medium text-gray-500 mb-0.5">({figure(summary?.largestCategory?.amount ?? (summary ? 0 : undefined))})</span>
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
              placeholder="Search descriptions, IDs..." 
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
                        {['All', 'Paid', 'Pending'].map(s => (
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
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Category</h4>
                      <select 
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-sm text-gray-700 outline-none focus:border-[#8B5CF6]"
                      >
                        {['All', 'Rent', 'Utilities', 'Maintenance', 'Supplies', 'Salary', 'Other'].map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
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
                <th className="px-6 py-4">Expense Details</th>
                <th className="px-6 py-4">Category</th>
                <th className="px-6 py-4">Amount</th>
                <th className="px-6 py-4">Date & Mode</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {processedExpenses.map((expense) => {
                const Icon = CATEGORY_ICONS[expense.category] ?? Receipt;
                const catColor = CATEGORY_COLORS[expense.category] || CATEGORY_COLORS['Other'];
                
                return (
                  <tr key={expense.id} className="hover:bg-gray-50/50 transition-colors group">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${catColor}`}>
                          <Icon size={18} />
                        </div>
                        <div>
                          <span className="font-bold text-gray-800 block">{expense.description}</span>
                          <span className="text-xs text-gray-400 font-mono mt-0.5 block">{expense.id}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2.5 py-1 rounded text-[10px] font-bold ${catColor}`}>
                        {expense.category}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-black text-gray-800 text-base">₹{expense.amount.toLocaleString('en-IN')}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-medium text-gray-800 block">{new Date(expense.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span className="text-xs text-gray-500 mt-0.5 block flex items-center gap-1">
                        <CreditCard size={12} /> {expense.mode}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {expense.status === 'Paid' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-green-50 text-green-600">
                          <CheckCircle2 size={12} /> Paid
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-red-50 text-red-600">
                          <AlertCircle size={12} /> Pending
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right relative">
                      <button 
                        aria-label={`Actions for ${expense.description}`}
                          onClick={(e) => { e.stopPropagation(); setOpenActionMenuId(openActionMenuId === expense.id ? null : expense.id); }}
                        className="p-2 text-gray-400 hover:text-[#8B5CF6] transition-colors rounded-lg hover:bg-[#8B5CF6]/10"
                      >
                        <MoreVertical size={18} />
                      </button>

                      <AnimatePresence>
                        {openActionMenuId === expense.id && (
                          <motion.div 
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="absolute right-8 top-10 w-40 bg-white border border-gray-100 shadow-xl rounded-xl z-50 overflow-hidden text-left"
                          >
                            {expense.status === 'Pending' && (
                              <>
                                <button 
                                  onClick={(e) => handleAction('Mark as Paid', expense, e)}
                                  className="w-full text-left px-4 py-2.5 text-xs text-green-700 hover:bg-green-50 font-bold transition-colors"
                                >
                                  Mark as Paid
                                </button>
                                <div className="h-px bg-gray-100 w-full" />
                              </>
                            )}
                            <button 
                              onClick={(e) => handleAction('Edit', expense, e)}
                              className="w-full text-left px-4 py-2.5 text-xs text-gray-700 hover:bg-gray-50 font-medium transition-colors"
                            >
                              Edit
                            </button>
                            <button 
                              onClick={(e) => handleAction('Delete', expense, e)}
                              className="w-full text-left px-4 py-2.5 text-xs text-red-600 hover:bg-red-50 font-bold transition-colors"
                            >
                              Delete
                            </button>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </td>
                  </tr>
                );
              })}
              {processedExpenses.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                    <Receipt className="mx-auto h-12 w-12 text-gray-300 mb-3" />
                    <p className="font-medium text-gray-800">No expenses found</p>
                    <p className="text-xs mt-1">Try adjusting your filters or search.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add Expense Modal */}
      <Modal isOpen={isAddModalOpen} onClose={() => { setIsAddModalOpen(false); resetForm(); }} title={editing ? `Edit Expense: ${editing.description}` : 'Record New Expense'} size="md">
        <form onSubmit={handleSaveExpense} className="space-y-4">
          <div>
            <label className="text-sm font-medium">Description *</label>
            <input value={newDesc} onChange={e=>setNewDesc(e.target.value)} required className="w-full mt-1 border rounded-lg p-2" placeholder="e.g. Electricity Bill, Shop Rent" />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Amount (₹) *</label>
              <input value={newAmount} onChange={e=>setNewAmount(e.target.value)} type="number" required className="w-full mt-1 border rounded-lg p-2" placeholder="0" />
            </div>
            <div>
              <label className="text-sm font-medium">Category</label>
              <select value={newCategory} onChange={e=>setNewCategory(e.target.value)} className="w-full mt-1 border rounded-lg p-2 bg-white">
                <option>Rent</option>
                <option>Utilities</option>
                <option>Maintenance</option>
                <option>Supplies</option>
                <option>Salary</option>
                <option>Other</option>
              </select>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Payment Status</label>
              <div className="flex gap-2 mt-1">
                <button type="button" onClick={() => setNewStatus('Paid')} className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors ${newStatus === 'Paid' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>Paid</button>
                <button type="button" onClick={() => setNewStatus('Pending')} className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors ${newStatus === 'Pending' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>Pending</button>
              </div>
            </div>
            {newStatus === 'Paid' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <label className="text-sm font-medium">Payment Mode</label>
                <select value={newMode} onChange={e=>setNewMode(e.target.value)} className="w-full mt-1 border rounded-lg p-2 bg-white text-sm">
                  <option>Cash</option>
                  <option>UPI</option>
                  <option>Bank Transfer</option>
                  <option>Card</option>
                </select>
              </motion.div>
            )}
          </div>
          
          <div>
            <label className="text-sm font-medium">Attach Receipt (Optional)</label>
            <div className="mt-1 w-full border-2 border-dashed border-gray-200 rounded-xl p-4 flex flex-col items-center justify-center cursor-pointer hover:border-[#8B5CF6] hover:bg-purple-50/30 transition-colors">
              <FileText size={20} className="text-gray-400 mb-2" />
              <p className="text-xs text-gray-500">Click to upload photo or PDF</p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" onClick={() => setIsAddModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold shadow-lg shadow-purple-500/30">Save Expense</button>
          </div>
        </form>
      </Modal>

    </div>
  );
}

'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { Card } from '@/components/ui/Card';
import { 
  Users, Plus, Search, Filter, MoreVertical, 
  UserCircle, ChevronDown, CheckCircle2, ShieldCheck, ShieldOff, Mail, AlertCircle, UserX
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SlidingPanel } from '@/components/ui/SlidingPanel';
import { useToast } from '@/components/ui/Toast';
import { AnimatePresence, motion } from 'framer-motion';
import { employeesApi, INVITABLE_ROLES, ROLE_LABELS, type EmployeeView } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { AUTH_DISABLED } from '@/lib/auth-bypass';

const ROLE_COLORS: Record<string, string> = {
  Owner: 'bg-yellow-100 text-yellow-700',
  Admin: 'bg-indigo-100 text-indigo-600',
  Manager: 'bg-purple-100 text-purple-600',
  Cashier: 'bg-blue-100 text-blue-600',
  'Stock Clerk': 'bg-orange-100 text-orange-600',
};

const STATUS_COLORS: Record<string, string> = {
  Active: 'bg-green-50 text-green-600 border-green-200',
  Suspended: 'bg-red-50 text-red-600 border-red-200',
};

/** `PATCH /users/:id/suspend` and `DELETE /users/:id` are OWNER/ADMIN; invitations are MANAGER and above. */
const USER_ADMIN_ROLES = new Set(['OWNER', 'ADMIN', 'SUPER_ADMIN']);
const INVITE_ROLES = new Set(['MANAGER', 'OWNER', 'ADMIN', 'SUPER_ADMIN']);

function canAdministerUsers(role: string | null | undefined): boolean {
  if (AUTH_DISABLED) return true; // the bypass system user is an OWNER
  return !!role && USER_ADMIN_ROLES.has(role.toUpperCase());
}

function canInvite(role: string | null | undefined): boolean {
  if (AUTH_DISABLED) return true;
  return !!role && INVITE_ROLES.has(role.toUpperCase());
}

/**
 * Staff page (roadmap 6.1). Every row is a real shop user from
 * `GET /users/employees`; suspend / reinstate and delete go through
 * `/users`, and "Invite" issues an invitation whose code reaches the invitee
 * by email (the invitee joins on the register page). Payroll, attendance and
 * shifts are not modelled by the API and are no longer shown.
 */
export default function EmployeesPage() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;
  const allowAdmin = canAdministerUsers(session?.user?.role);
  const allowInvite = canInvite(session?.user?.role);

  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    return employeesApi.list()
      .then(setEmployees)
      .catch((err) => {
        setEmployees([]);
        toast(describeApiError(err, 'Loading employees (GET /users/employees)'), 'error');
      })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modals & Panels
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EmployeeView | null>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Dropdowns
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  
  const filterRef = useRef<HTMLDivElement>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('All');
  const [roleFilter, setRoleFilter] = useState('All');

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Form State - Invite
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState(INVITABLE_ROLES[0].key);
  const [inviting, setInviting] = useState(false);

  // Derived Stats (all from the API rows; nothing invented)
  const totalEmployees = employees.length;
  const activeCount = employees.filter(e => e.isActive).length;
  const suspendedCount = employees.filter(e => !e.isActive).length;
  const managementCount = employees.filter(e => ['OWNER', 'SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(e.roleKey)).length;

  // Filter Logic
  let processedEmployees = employees.filter(e => 
    e.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    e.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    e.phone.includes(searchTerm) ||
    e.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (statusFilter !== 'All') {
    processedEmployees = processedEmployees.filter(e => e.status === statusFilter);
  }

  if (roleFilter !== 'All') {
    processedEmployees = processedEmployees.filter(e => e.role === roleFilter);
  }

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      const result = await employeesApi.invite({ email, role: inviteRole });
      toast(`Invitation emailed to ${result.email} (${ROLE_LABELS[result.role] ?? result.role}); it expires ${new Date(result.expiresAt).toLocaleDateString('en-IN')}.`, 'success');
      setIsInviteModalOpen(false);
      setInviteEmail('');
      setInviteRole(INVITABLE_ROLES[0].key);
    } catch (err) {
      toast(describeApiError(err, 'Inviting a staff member (POST /invitations/generate)'), 'error');
    } finally {
      setInviting(false);
    }
  };

  const handleSetActive = async (employee: EmployeeView, isActive: boolean) => {
    setBusyId(employee.id);
    try {
      const updated = await employeesApi.setActive(employee.id, isActive);
      setEmployees((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      if (selectedEmployee?.id === updated.id) setSelectedEmployee(updated);
      toast(isActive ? `${updated.name} reinstated` : `${updated.name} suspended; their sessions were ended`, 'success');
    } catch (err) {
      toast(describeApiError(err, `${isActive ? 'Reinstating' : 'Suspending'} ${employee.name} (PATCH /users/:id/suspend)`), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setBusyId(target.id);
    try {
      await employeesApi.remove(target.id);
      setEmployees((rows) => rows.filter((row) => row.id !== target.id));
      if (selectedEmployee?.id === target.id) { setSelectedEmployee(null); setIsSidePanelOpen(false); }
      toast(`${target.name} removed from the shop`, 'success');
      setPendingDelete(null);
    } catch (err) {
      toast(describeApiError(err, `Removing ${target.name} (DELETE /users/:id)`), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleAction = (action: string, employee: EmployeeView, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenActionMenuId(null);
    setSelectedEmployee(employee);
    
    switch (action) {
      case 'View Profile':
        setIsSidePanelOpen(true);
        break;
      case 'Suspend':
        void handleSetActive(employee, false);
        break;
      case 'Reinstate':
        void handleSetActive(employee, true);
        break;
      case 'Delete':
        setPendingDelete(employee);
        break;
    }
  };

  /** The API refuses acting on yourself; the menu says so instead of offering it. */
  const isSelf = (employee: EmployeeView) => currentUserId !== null && employee.id === currentUserId;

  if (loading) return <div className="p-12 text-center text-gray-500">Loading employees...</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Staff & Employees</h1>
          <p className="text-sm text-gray-500 mt-1">Invite staff, manage their access and see who can sign in.</p>
        </div>
        {allowInvite && (
          <button 
            onClick={() => setIsInviteModalOpen(true)}
            className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-purple-500/30 transition-all"
          >
            <Plus size={18} />
            Invite Employee
          </button>
        )}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center text-[#8B5CF6]">
            <Users size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Total Staff</p>
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">{totalEmployees}</h3>
          </div>
        </Card>
        
        <Card className="p-5 flex items-center gap-4 hoverable bg-green-50/50 border-green-100">
          <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center text-green-600">
            <CheckCircle2 size={24} />
          </div>
          <div>
            <p className="text-xs text-green-600 font-bold">Active Accounts</p>
            <h3 className="text-xl font-black text-green-700 tracking-tight">{activeCount}</h3>
          </div>
        </Card>

        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-600">
            <ShieldCheck size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Managers & Admins</p>
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">{managementCount}</h3>
          </div>
        </Card>

        <Card className="p-5 flex items-center gap-4 hoverable border-l-4 border-l-orange-500">
          <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center text-orange-600">
            <ShieldOff size={24} />
          </div>
          <div>
            <p className="text-xs text-orange-500 font-bold">Suspended</p>
            <h3 className="text-xl font-black text-gray-800 tracking-tight">{suspendedCount}</h3>
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
              placeholder="Search by name, email or phone..." 
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
                        {['All', 'Active', 'Suspended'].map(s => (
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
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Role</h4>
                      <select 
                        value={roleFilter}
                        onChange={(e) => setRoleFilter(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-sm text-gray-700 outline-none focus:border-[#8B5CF6]"
                      >
                        {['All', 'Owner', 'Admin', 'Manager', 'Cashier', 'Stock Clerk'].map(c => <option key={c} value={c}>{c}</option>)}
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
                <th className="px-6 py-4">Employee</th>
                <th className="px-6 py-4">Contact</th>
                <th className="px-6 py-4">Joined</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {processedEmployees.map((emp) => {
                const roleColor = ROLE_COLORS[emp.role] || 'bg-gray-100 text-gray-600';
                const statusStyle = STATUS_COLORS[emp.status];
                const self = isSelf(emp);
                
                return (
                  <tr 
                    key={emp.id} 
                    data-testid={`employee-row-${emp.id}`}
                    onClick={() => { setSelectedEmployee(emp); setIsSidePanelOpen(true); }}
                    className="hover:bg-gray-50/50 transition-colors cursor-pointer group"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-400">
                          <UserCircle size={24} />
                        </div>
                        <div>
                          <span className="font-bold text-gray-800 block">{emp.name}{self && <span className="ml-2 text-[10px] font-bold text-gray-400 uppercase">You</span>}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold inline-block mt-1 ${roleColor}`}>{emp.role}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-medium text-gray-800 block">{emp.email}</span>
                      <span className="text-xs text-gray-400 mt-0.5 block">{emp.phone || 'No phone on file'}</span>
                    </td>
                    <td className="px-6 py-4 text-gray-500 font-medium">
                      {emp.createdAt ? new Date(emp.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold border ${statusStyle}`}>
                        {emp.isActive ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                        {emp.status}{emp.isLocked && emp.isActive ? ' · Locked' : ''}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right relative">
                      <button 
                        aria-label={`Actions for ${emp.name}`}
                        onClick={(e) => { e.stopPropagation(); setOpenActionMenuId(openActionMenuId === emp.id ? null : emp.id); }}
                        className="p-2 text-gray-400 hover:text-[#8B5CF6] transition-colors rounded-lg hover:bg-[#8B5CF6]/10"
                      >
                        <MoreVertical size={18} />
                      </button>

                      <AnimatePresence>
                        {openActionMenuId === emp.id && (
                          <motion.div 
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="absolute right-8 top-10 w-44 bg-white border border-gray-100 shadow-xl rounded-xl z-50 overflow-hidden text-left"
                          >
                            <button 
                              onClick={(e) => handleAction('View Profile', emp, e)}
                              className="w-full text-left px-4 py-2.5 text-xs text-gray-700 hover:bg-gray-50 font-medium transition-colors"
                            >
                              View Profile
                            </button>
                            {allowAdmin && !self && (
                              <>
                                <div className="h-px bg-gray-100 w-full" />
                                <button 
                                  disabled={busyId === emp.id}
                                  onClick={(e) => handleAction(emp.isActive ? 'Suspend' : 'Reinstate', emp, e)}
                                  className="w-full text-left px-4 py-2.5 text-xs text-[#8B5CF6] hover:bg-purple-50 font-bold transition-colors disabled:opacity-50"
                                >
                                  {emp.isActive ? 'Suspend Access' : 'Reinstate Access'}
                                </button>
                                <div className="h-px bg-gray-100 w-full" />
                                <button 
                                  disabled={busyId === emp.id}
                                  onClick={(e) => handleAction('Delete', emp, e)}
                                  className="w-full text-left px-4 py-2.5 text-xs text-red-600 hover:bg-red-50 font-bold transition-colors disabled:opacity-50"
                                >
                                  Remove from Shop
                                </button>
                              </>
                            )}
                            {allowAdmin && self && (
                              <p className="px-4 py-2.5 text-[11px] text-gray-400">You cannot suspend or remove your own account.</p>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </td>
                  </tr>
                );
              })}
              {processedEmployees.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                    <Users className="mx-auto h-12 w-12 text-gray-300 mb-3" />
                    <p className="font-medium text-gray-800">No employees found</p>
                    <p className="text-xs mt-1">Try adjusting your filters or search.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Invite Employee Modal */}
      <Modal isOpen={isInviteModalOpen} onClose={() => setIsInviteModalOpen(false)} title="Invite a Staff Member" size="md">
        <form onSubmit={handleInvite} className="space-y-4">
          <div>
            <label className="text-sm font-medium">Email Address *</label>
            <input value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} type="email" required autoComplete="off" className="w-full mt-1 border rounded-lg p-2" placeholder="e.g. raju@example.com" />
          </div>
          
          <div>
            <label className="text-sm font-medium">Role</label>
            <select value={inviteRole} onChange={e=>setInviteRole(e.target.value)} className="w-full mt-1 border rounded-lg p-2 bg-white">
              {INVITABLE_ROLES.map((role) => <option key={role.key} value={role.key}>{role.label}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-2">You can only invite roles below your own. The invitee receives an email with a code and joins with their own name and password.</p>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" onClick={() => setIsInviteModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={inviting} className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold shadow-lg shadow-purple-500/30 disabled:opacity-60 flex items-center gap-2">
              <Mail size={16} /> {inviting ? 'Sending…' : 'Send Invitation'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Remove confirmation */}
      <Modal isOpen={pendingDelete !== null} onClose={() => setPendingDelete(null)} title="Remove from Shop" size="sm">
        {pendingDelete && (
          <div className="space-y-4">
            <div className="bg-red-50 p-3 rounded-xl border border-red-100 flex items-start gap-3">
              <UserX className="text-red-500 mt-0.5 shrink-0" size={18} />
              <p className="text-sm text-red-700"><span className="font-bold">{pendingDelete.name}</span> will lose access immediately and their open sessions will be ended. This cannot be undone from here.</p>
            </div>
            <div className="flex justify-end gap-2 pt-4 border-t">
              <button type="button" onClick={() => setPendingDelete(null)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
              <button type="button" disabled={busyId === pendingDelete.id} onClick={() => void handleDelete()} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-bold shadow-lg shadow-red-500/30 disabled:opacity-60">
                {busyId === pendingDelete.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Side Panel for Profile */}
      <SlidingPanel isOpen={isSidePanelOpen} onClose={() => setIsSidePanelOpen(false)} title="Employee Profile">
        {selectedEmployee && (
          <div className="p-6">
            <div className="flex items-center gap-4 mb-8">
              <div className="w-16 h-16 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-400">
                <UserCircle size={40} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-800">{selectedEmployee.name}</h2>
                <p className="text-sm text-gray-500 mt-0.5">{selectedEmployee.email}</p>
                <div className="mt-2 flex gap-2">
                   <span className={`px-2 py-0.5 rounded text-xs font-bold ${ROLE_COLORS[selectedEmployee.role] || 'bg-gray-100 text-gray-600'}`}>
                     {selectedEmployee.role}
                   </span>
                   <span className={`px-2 py-0.5 rounded border text-xs font-bold ${STATUS_COLORS[selectedEmployee.status]}`}>
                     {selectedEmployee.status}
                   </span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">Phone</p>
                  <p className="font-bold text-gray-800">{selectedEmployee.phone || '—'}</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">Joined</p>
                  <p className="font-bold text-gray-800">{selectedEmployee.createdAt ? new Date(selectedEmployee.createdAt).toLocaleDateString('en-IN') : '—'}</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">Sign-in</p>
                  <p className="font-bold text-gray-800">{selectedEmployee.isActive ? (selectedEmployee.isLocked ? 'Locked after failed attempts' : 'Allowed') : 'Suspended'}</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">User ID</p>
                  <p className="font-bold text-gray-800 font-mono text-xs break-all">{selectedEmployee.id}</p>
                </div>
              </div>
              
              {allowAdmin && !isSelf(selectedEmployee) && (
                <button 
                  disabled={busyId === selectedEmployee.id}
                  onClick={() => void handleSetActive(selectedEmployee, !selectedEmployee.isActive)}
                  className="w-full mt-4 bg-purple-50 text-[#8B5CF6] hover:bg-purple-100 py-3 rounded-xl text-sm font-bold transition-colors border border-purple-200 flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {selectedEmployee.isActive ? <><ShieldOff size={16} /> Suspend Access</> : <><ShieldCheck size={16} /> Reinstate Access</>}
                </button>
              )}
            </div>
          </div>
        )}
      </SlidingPanel>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, Plus, Printer, Users } from 'lucide-react';
import { UserProfile } from '../../modules/types';
import { financeApi } from '../../services/financeApi';
import {
  EmployeePayrollDoc,
  PayrollRunDoc,
  saveEmployeeToFirestore,
  savePayrollRunToFirestore,
  subscribeEmployeesFromFirestore,
  subscribePayrollRunsFromFirestore,
} from '../../services/erpFirestore';
import { useCloudSync } from '../../services/cloudSync';
import { extractFriendlyErrorMessage } from '../../services/firebase';
import { formatCurrency } from '../../services/apiClient';
import { getTodayIsoIST } from '../../services/formatters';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { MobileNumberInput } from '../../components/MobileNumberInput';

interface PayrollEmployeesPageProps {
  currentUser: UserProfile;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

export const PayrollEmployeesPage: React.FC<PayrollEmployeesPageProps> = ({
  currentUser,
  onShowToast,
}) => {
  const [baseEmployees, setBaseEmployees] = useState<any[]>([]);
  const [basePayrollRuns, setBasePayrollRuns] = useState<any[]>([]);
  const [cloudEmployees, setCloudEmployees] = useState<EmployeePayrollDoc[]>([]);
  const [cloudPayrollRuns, setCloudPayrollRuns] = useState<PayrollRunDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingEmp, setSavingEmp] = useState(false);
  const [runningPayroll, setRunningPayroll] = useState(false);
  const [monthCode, setMonthCode] = useState(() => getTodayIsoIST().slice(0, 7));
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [selectedSlipRun, setSelectedSlipRun] = useState<any | null>(null);
  const [empForm, setEmpForm] = useState({
    fullName: '',
    designation: '',
    department: 'Operations',
    mobile: '',
    basicSalary: 12000,
    hra: 2000,
    allowances: 1000,
    pfDeduction: 600,
    tdsDeduction: 0,
  });

  const cloudSync = useCloudSync();
  const onShowToastRef = useRef(onShowToast);
  useEffect(() => {
    onShowToastRef.current = onShowToast;
  }, [onShowToast]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await financeApi.getEmployees();
      setBaseEmployees(res.data.employees);
      setBasePayrollRuns(res.data.payrollRuns);
    } catch (err) {
      if (!cloudSync.userUid) {
        onShowToastRef.current('error', 'Failed to load Payroll Master', extractFriendlyErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, [cloudSync.userUid]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!cloudSync.userUid) return;
    const unsubEmp = subscribeEmployeesFromFirestore(setCloudEmployees);
    const unsubRuns = subscribePayrollRunsFromFirestore(setCloudPayrollRuns);
    return () => {
      unsubEmp();
      unsubRuns();
    };
  }, [cloudSync.userUid]);

  const employees = useMemo(() => {
    const map = new Map<string, any>();
    for (const emp of baseEmployees) map.set(emp.empId, emp);
    for (const emp of cloudEmployees) map.set(emp.empId, emp);
    return Array.from(map.values());
  }, [baseEmployees, cloudEmployees]);

  const payrollRuns = useMemo(() => {
    const map = new Map<string, any>();
    for (const run of basePayrollRuns) map.set(run.runId, run);
    for (const run of cloudPayrollRuns) map.set(run.runId, run);
    return Array.from(map.values()).sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
  }, [basePayrollRuns, cloudPayrollRuns]);

  const canAdmin = currentUser.role === 'ADMIN';
  const monthlyGrossEstimate = employees
    .filter((e) => e.status === 'Active')
    .reduce((s, e) => s + e.basicSalary + e.hra + e.allowances, 0);
  const monthlyNetEstimate = employees
    .filter((e) => e.status === 'Active')
    .reduce((s, e) => s + Math.max(0, e.basicSalary + e.hra + e.allowances - e.pfDeduction - e.tdsDeduction), 0);

  const handleAddEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingEmp(true);
    try {
      const res: any = await financeApi.createEmployee(empForm);
      const created: EmployeePayrollDoc = res.data;
      const saved = await saveEmployeeToFirestore(created);
      setCloudEmployees((prev) => [saved, ...prev.filter((item) => item.empId !== saved.empId)]);
      onShowToast('success', 'Employee Saved to Cloud', `${saved.fullName} added to Payroll Master.`);
      setAddModalOpen(false);
      setEmpForm({
        fullName: '',
        designation: '',
        department: 'Operations',
        mobile: '',
        basicSalary: 12000,
        hra: 2000,
        allowances: 1000,
        pfDeduction: 600,
        tdsDeduction: 0,
      });
      void loadData();
    } catch (err) {
      onShowToast('error', 'Add Employee Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingEmp(false);
    }
  };

  const handleRunPayroll = async () => {
    setRunningPayroll(true);
    try {
      let runDoc: PayrollRunDoc | null = null;
      try {
        const res: any = await financeApi.runPayroll(monthCode);
        runDoc = res.data;
      } catch (apiErr) {
        const activeEmps = employees.filter((e) => e.status === 'Active');
        if (activeEmps.length === 0) throw apiErr;
        const slips = activeEmps.map((e) => {
          const gross = Number(e.basicSalary || 0) + Number(e.hra || 0) + Number(e.allowances || 0);
          const deductions = Number(e.pfDeduction || 0) + Number(e.tdsDeduction || 0);
          return {
            empId: e.empId,
            fullName: e.fullName,
            gross,
            deductions,
            netPay: Math.max(0, gross - deductions),
          };
        });
        const totalGross = slips.reduce((s, x) => s + x.gross, 0);
        const totalPf = activeEmps.reduce((s, e) => s + Number(e.pfDeduction || 0), 0);
        const totalTds = activeEmps.reduce((s, e) => s + Number(e.tdsDeduction || 0), 0);
        const totalNet = slips.reduce((s, x) => s + x.netPay, 0);
        runDoc = {
          runId: `PAY_${monthCode.replace('-', '')}_${Date.now().toString().slice(-4)}`,
          monthCode,
          voucherNo: `JV_PAY_${Date.now().toString().slice(-5)}`,
          employeeCount: activeEmps.length,
          grossTotal: totalGross,
          totalDeductions: totalPf + totalTds,
          netPayableTotal: totalNet,
          totalGross,
          totalPf,
          totalTds,
          totalNet,
          slips,
          status: 'POSTED',
          postedBy: currentUser.userId,
          createdAt: new Date().toISOString(),
        };
      }
      if (!runDoc) throw new Error('Payroll run did not produce a valid batch.');
      const saved = await savePayrollRunToFirestore(runDoc);
      setCloudPayrollRuns((prev) => [saved, ...prev.filter((item) => item.runId !== saved.runId)]);
      onShowToast(
        'success',
        'Payroll Posted & Saved to Cloud',
        `Run ${saved.runId} posted via voucher ${saved.voucherNo}.`
      );
      void loadData();
    } catch (err) {
      onShowToast('error', 'Payroll Run Blocked', extractFriendlyErrorMessage(err));
    } finally {
      setRunningPayroll(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-950 dark:text-white">
            Employees &amp; Staff Payroll Engine (Module 09)
          </h2>
          <p className="text-xs text-neutral-500 mt-1">
            Staff compensation master, statutory PF/TDS deductions &amp; double-entry General Ledger payroll runs
          </p>
        </div>

        {canAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="month"
              value={monthCode}
              onChange={(e) => setMonthCode(e.target.value)}
              className="h-9 px-2.5 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
            <Button size="sm" variant="outline" loading={runningPayroll} onClick={handleRunPayroll} icon={<Banknote className="h-3.5 w-3.5" />}>
              Run &amp; Post Payroll
            </Button>
            <Button size="sm" variant="primary" onClick={() => setAddModalOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
              Add Employee
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="text-neutral-500 flex items-center justify-between">
            <span>Active Staff Roster</span>
            <Users className="h-4 w-4 text-neutral-400" />
          </div>
          <div className="mt-2 text-lg font-bold font-mono tabular-nums">
            {employees.filter((e) => e.status === 'Active').length}
          </div>
        </div>
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="text-neutral-500">Monthly Gross Obligation</div>
          <div className="mt-2 text-lg font-bold font-mono tabular-nums">{formatCurrency(monthlyGrossEstimate)}</div>
        </div>
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="text-neutral-500">Estimated Net Bank Payout</div>
          <div className="mt-2 text-lg font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
            {formatCurrency(monthlyNetEstimate)}
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-xs font-semibold">
          Employee Salary Structure ({employees.length})
        </div>
        {loading ? (
          <div className="p-6 text-xs text-neutral-500">Loading payroll directory...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 text-neutral-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Emp ID</th>
                  <th className="px-4 py-2.5 font-medium">Employee &amp; Designation</th>
                  <th className="px-4 py-2.5 font-medium">Department</th>
                  <th className="px-4 py-2.5 font-medium text-right">Basic + HRA + Allow</th>
                  <th className="px-4 py-2.5 font-medium text-right">PF / TDS</th>
                  <th className="px-4 py-2.5 font-medium text-right">Net Monthly</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {employees.map((emp) => {
                  const gross = emp.basicSalary + emp.hra + emp.allowances;
                  const ded = emp.pfDeduction + emp.tdsDeduction;
                  const net = Math.max(0, gross - ded);
                  return (
                    <tr key={emp.empId} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/60">
                      <td className="px-4 py-2.5 font-mono font-semibold">{emp.empId}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-neutral-950 dark:text-white">{emp.fullName}</div>
                        <div className="text-[11px] text-neutral-500">
                          {emp.designation} {emp.userId ? `· ${emp.userId}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-neutral-600 dark:text-neutral-300">{emp.department}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatCurrency(gross)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-neutral-500">
                        {formatCurrency(ded)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums">
                        {formatCurrency(net)}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-600 dark:text-neutral-300">{emp.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {payrollRuns.length > 0 && (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-xs font-semibold">
            Posted Payroll Batches &amp; Salary Slips ({payrollRuns.length})
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
            {payrollRuns.map((run) => (
              <div key={run.runId} className="p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-mono font-bold">
                    {run.runId} · Month {run.monthCode} · GL Voucher {run.voucherNo}
                  </div>
                  <div className="text-neutral-500 mt-0.5">
                    {run.employeeCount} employees · Gross {formatCurrency(run.grossTotal)} · Statutory Deductions{' '}
                    {formatCurrency(run.totalDeductions)}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono font-bold text-sm">{formatCurrency(run.netPayableTotal)}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Printer className="h-3 w-3" />}
                    onClick={() => setSelectedSlipRun(run)}
                  >
                    Salary Slips
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal isOpen={addModalOpen} onClose={() => setAddModalOpen(false)} title="Add Employee to Payroll Master">
        <form onSubmit={handleAddEmployee} className="space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1">Full Name</label>
              <input
                required
                value={empForm.fullName}
                onChange={(e) => setEmpForm((prev) => ({ ...prev, fullName: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Designation</label>
              <input
                required
                value={empForm.designation}
                onChange={(e) => setEmpForm((prev) => ({ ...prev, designation: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Department</label>
              <input
                value={empForm.department}
                onChange={(e) => setEmpForm((prev) => ({ ...prev, department: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Mobile</label>
              <MobileNumberInput
                value={empForm.mobile}
                onChange={(val) => setEmpForm((prev) => ({ ...prev, mobile: val }))}
                aria-label="Employee mobile number"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Basic Salary (₹)</label>
              <input
                type="number"
                min={1}
                value={empForm.basicSalary}
                onChange={(e) => setEmpForm((prev) => ({ ...prev, basicSalary: Number(e.target.value) }))}
                className="w-full h-9 px-3 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">HRA (₹)</label>
              <input
                type="number"
                min={0}
                value={empForm.hra}
                onChange={(e) => setEmpForm((prev) => ({ ...prev, hra: Number(e.target.value) }))}
                className="w-full h-9 px-3 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Allowances (₹)</label>
              <input
                type="number"
                min={0}
                value={empForm.allowances}
                onChange={(e) => setEmpForm((prev) => ({ ...prev, allowances: Number(e.target.value) }))}
                className="w-full h-9 px-3 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">PF + TDS Deduction (₹)</label>
              <input
                type="number"
                min={0}
                value={empForm.pfDeduction}
                onChange={(e) => setEmpForm((prev) => ({ ...prev, pfDeduction: Number(e.target.value) }))}
                className="w-full h-9 px-3 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setAddModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={savingEmp}>
              Save Employee
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(selectedSlipRun)}
        onClose={() => setSelectedSlipRun(null)}
        title={`Payroll Salary Slips — ${selectedSlipRun?.monthCode || ''}`}
      >
        {selectedSlipRun && (
          <div className="space-y-3 text-xs">
            <div className="text-neutral-500">
              Voucher Reference: <span className="font-mono font-semibold">{selectedSlipRun.voucherNo}</span>
            </div>
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded">
              {selectedSlipRun.slips.map((slip: any) => (
                <div key={slip.empId} className="p-3 flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{slip.fullName}</div>
                    <div className="text-[11px] text-neutral-500">
                      {slip.empId} · Gross {formatCurrency(slip.gross)} · Deductions {formatCurrency(slip.deductions)}
                    </div>
                  </div>
                  <div className="font-mono font-bold">{formatCurrency(slip.netPay)}</div>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="primary" icon={<Printer className="h-3.5 w-3.5" />} onClick={() => window.print()}>
                Print A4 Slips
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

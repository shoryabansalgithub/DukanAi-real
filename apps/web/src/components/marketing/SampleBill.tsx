/**
 * A sample DukaanAI receipt drawn in HTML (no image to download, so it is
 * part of the first paint). The figures add up: 5 % and 18 % lines, CGST
 * and SGST at half the rate each, a round-off to the rupee, and part of the
 * bill on udhar.
 */
const LINES = [
  { name: 'Basmati rice 5 kg', qty: 1, rate: 5, amount: '480.00' },
  { name: 'Ghee 1 L', qty: 1, rate: 5, amount: '560.00' },
  { name: 'Room freshener', qty: 2, rate: 18, amount: '220.00' },
];

const TAX = [
  { rate: '5%', taxable: '1,040.00', cgst: '26.00', sgst: '26.00' },
  { rate: '18%', taxable: '220.00', cgst: '19.80', sgst: '19.80' },
];

export function SampleBill() {
  return (
    <figure className="relative isolate mx-auto w-full max-w-[360px]">
      <div aria-hidden="true" className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-indigo-100 via-violet-50 to-sky-100 blur-2xl" />
      <div className="rounded-2xl border border-slate-200 bg-white p-5 font-mono text-[12.5px] leading-[1.55] text-slate-800 shadow-xl shadow-indigo-900/10 sm:p-6">
        <div className="text-center">
          <p className="font-sans text-[15px] font-bold text-slate-900">Sharma General Store</p>
          <p className="text-slate-500">GSTIN 07ABCDE1234F1Z5</p>
          <p className="mt-2 font-sans text-[11px] font-bold tracking-[0.2em] text-slate-900">TAX INVOICE</p>
        </div>
        <div className="mt-3 flex justify-between border-y border-dashed border-slate-300 py-1.5 text-slate-600">
          <span>INV-2627-000184</span>
          <span>14 Nov 2026</span>
        </div>
        <table className="mt-2 w-full">
          <caption className="sr-only">Items</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Item</th>
              <th scope="col">GST</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {LINES.map((line) => (
              <tr key={line.name} className="align-top">
                <td className="py-0.5 pr-2">
                  {line.name}
                  <span className="text-slate-500"> ×{line.qty}</span>
                </td>
                <td className="py-0.5 pr-2 text-right text-slate-500">{line.rate}%</td>
                <td className="py-0.5 text-right">{line.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="mt-2 w-full border-t border-dashed border-slate-300 text-[11.5px] text-slate-600">
          <caption className="sr-only">Tax by rate</caption>
          <thead>
            <tr>
              <th scope="col" className="pt-1.5 text-left font-normal">Rate</th>
              <th scope="col" className="pt-1.5 text-right font-normal">Taxable</th>
              <th scope="col" className="pt-1.5 text-right font-normal">CGST</th>
              <th scope="col" className="pt-1.5 text-right font-normal">SGST</th>
            </tr>
          </thead>
          <tbody>
            {TAX.map((row) => (
              <tr key={row.rate}>
                <td>{row.rate}</td>
                <td className="text-right">{row.taxable}</td>
                <td className="text-right">{row.cgst}</td>
                <td className="text-right">{row.sgst}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-2 space-y-0.5 border-t border-dashed border-slate-300 pt-1.5">
          <div className="flex justify-between text-slate-600">
            <dt>Round off</dt>
            <dd>+0.40</dd>
          </div>
          <div className="flex justify-between font-sans text-[15px] font-bold text-slate-900">
            <dt>Total</dt>
            <dd>₹1,352.00</dd>
          </div>
          <div className="flex justify-between pt-1">
            <dt>Paid by UPI</dt>
            <dd>1,000.00</dd>
          </div>
          <div className="flex justify-between">
            <dt>Udhar · Ramesh K.</dt>
            <dd>352.00</dd>
          </div>
        </dl>
      </div>
      <figcaption className="mt-4 text-center text-sm text-slate-500">A sample bill: CGST and SGST by rate, part paid by UPI, the rest on udhar.</figcaption>
    </figure>
  );
}

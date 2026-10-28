import { useTenantData } from "../data/tenantData";
import { formatBalance, formatCurrency } from "../components/formatCurrency";

export function LedgerPage() {
  const { ledger, leaseDocument } = useTenantData();
  return (
    <section className="portal-panel" aria-label="Full ledger">
      {leaseDocument && (
        <p className="ledger-lease-doc">
          <a href="/api/tenant/lease-document" target="_blank" rel="noopener">
            View your signed lease (PDF)
          </a>{" "}
          <span className="ledger-lease-doc__when">uploaded {leaseDocument.uploadedOn}</span>
        </p>
      )}
       <div className="table-scroll">
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Description</th>
            <th scope="col">Method</th>
            <th scope="col">Amount</th>
            <th scope="col">Balance</th>
          </tr>
        </thead>
        <tbody>
          {ledger.map((entry) => (
            <tr key={entry.id}>
              <td data-label="Date">{entry.date}</td>
              <td data-label="Description">{entry.description}</td>
              <td data-label="Method">{entry.method ?? "-"}</td>
              <td data-label="Amount" className={"amount-cell" + (entry.amount > 0 ? " amount-cell--credit" : "")}>
                {entry.amount > 0 ? "+" : ""}
                {formatCurrency(entry.amount)}
              </td>
              <td data-label="Balance">{formatBalance(entry.balanceAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

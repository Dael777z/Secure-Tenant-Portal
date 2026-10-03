import { mockLedger } from "../data/mockData";
import { formatCurrency } from "../components/formatCurrency";

export function LedgerPage() {
  return (
    <section className="portal-panel" aria-label="Full ledger">
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
          {mockLedger.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.date}</td>
              <td>{entry.description}</td>
              <td>{entry.method ?? "-"}</td>
              <td className={"amount-cell" + (entry.amount > 0 ? " amount-cell--credit" : "")}>
                {entry.amount > 0 ? "+" : ""}
                {formatCurrency(entry.amount)}
              </td>
              <td>{formatCurrency(entry.balanceAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

//Shared domain types for the tenant side Resident Portal

export type PageKey = "home" | "pay" | "ledger" | "maintenance" | "documents" | "notices" | "settings";

export interface Tenant {
  id: string;
  name: string;
  initials: string;
  unitLabel: string;
  address: string;
}

export interface LedgerEntry {
  id: string;
  date: string;
  /** YYYY-MM-DD, for exports. */
  isoDate: string;
  type: "charge" | "payment" | "refund";
  description: string;
  method: string | null; 
  amount: number; 
  balanceAfter: number;
  confirmation?: string;
}

export type MaintenanceStatus = "open" | "in_progress" | "resolved";

export interface MaintenanceRequest {
  id: string;
  title: string;
  description: string;
  submittedDate: string;
  status: MaintenanceStatus;
}

export type NoticeType = "payment" | "due" | "maintenance";

export interface Notice {
  id: string;
  type: NoticeType;
  title: string;
  body: string;
  nextStep: string;
  timestamp: string;
}

// Juan (tenant-side-ui 23d7a8e): bank first, then Cash App and Zelle; "Other" is gone.
// 010: debit/credit cards, and Apple Pay / Google Pay ("wallet"), through Stripe.
export type PaymentMethodKind = "bank" | "card" | "wallet" | "cashapp" | "zelle";

/** Cash App / Zelle: sent from the tenant's own app, then reported ("I've sent it"). */
export type ManualPayMethod = "cashapp" | "zelle";

export interface PaymentMethodOption {
  kind: PaymentMethodKind;
  label: string;
  sublabel: string;
}

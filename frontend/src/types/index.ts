//Shared domain types for the tenant side Resident Portal

export type PageKey = "home" | "pay" | "ledger" | "maintenance" | "notices";

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

export type PaymentMethodKind = "bank" | "card" | "wallet" | "other";

export interface PaymentMethodOption {
  kind: PaymentMethodKind;
  label: string;
  sublabel: string;
}

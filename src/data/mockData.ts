import type {
  Tenant,
  LedgerEntry,
  MaintenanceRequest,
  Notice,
  PaymentMethodOption,
} from "../types";

//mock data for now
export const mockTenant: Tenant = {
  id: "tenant_diana_lewis",
  name: "Diana Lewis",
  initials: "DL",
  unitLabel: "Unit 4B - Red Gardens",
  address: "840 Oak St, Buffalo NY 14201",
};

export const mockLedger: LedgerEntry[] = [
  {
    id: "le_1",
    date: "Oct 1, 2026",
    description: "Rent charge - October",
    method: null,
    amount: -1500.0,
    balanceAfter: 1500.0,
  },
  {
    id: "le_2",
    date: "Sep 3, 2026",
    description: "Payment received",
    method: "Visa 1234",
    amount: 1500.0,
    balanceAfter: 0.0,
    confirmation: "CONF-88213",
  },
  {
    id: "le_3",
    date: "Sep 1, 2026",
    description: "Rent Charge - September",
    method: null,
    amount: -1500.0,
    balanceAfter: 1500.0,
  },
  {
    id: "le_4",
    date: "Jul 5, 2026",
    description: "Payment received",
    method: "Checking 0333",
    amount: 1500.0,
    balanceAfter: 0.0,
    confirmation: "CONF-77031",
  },
];

export const mockMaintenanceRequests: MaintenanceRequest[] = [
  {
    id: "mr_1",
    title: "Kitchen faucet leaking",
    description:
      "Steady drip under the sink, worse in the morning. Started about a week ago.",
    submittedDate: "Sep 29, 2026",
    status: "in_progress",
  },
  {
    id: "mr_2",
    title: "Dishwasher clogged",
    description: "Water pools at the bottom after a full cycle.",
    submittedDate: "Aug 15, 2026",
    status: "resolved",
  },
];

export const mockNotices: Notice[] = [
  {
    id: "n_1",
    type: "payment",
    title: "Payment received",
    body: "Your payment of $1,500.00 was received and applied to your account.",
    nextStep: "No action needed - your receipt is in the ledger.",
    timestamp: "Sep 3, 2026",
  },
  {
    id: "n_2",
    type: "due",
    title: "Rent Due October 1",
    body: "Your balance of $1,500.00 is due October 1. A late fee applies October 5.",
    nextStep: "Pay from the Pay tab to avoid the late fee.",
    timestamp: "Sep 25, 2026",
  },
  {
    id: "n_3",
    type: "maintenance",
    title: "Repair update: Kitchen faucet",
    body: "A technician is scheduled for this week.",
    nextStep: "No action needed - we'll notify you when it's resolved.",
    timestamp: "Sep 29, 2026",
  },
];

//Bank Account listed first and enabled
export const paymentMethodOptions: PaymentMethodOption[] = [
  { kind: "bank", label: "Bank Account", sublabel: "Connected via Plaid" },
  {
    kind: "card",
    label: "Credit/Debit Card",
    sublabel: "Visa ending in 1234",
  },
  {
    kind: "wallet",
    label: "Digital Wallet",
    sublabel: "Apple Pay",
  },
  { kind: "other", label: "Other", sublabel: "      " }
];

export const currentBalance = 1500.0;
export const rentDueDate = "November 1";
export const lateFeeGraceDate = "Nov 5";

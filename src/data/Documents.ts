// Documents the office has on file for the signed-in tenant.
// All Mockdata

export type DocumentKind = "lease";

export interface TenantDocument {
  id: string;
  title: string;
  kind: DocumentKind;
  description: string;
  //Pre-formatted like the rest of the portal's dates ("Dec 15, 2025")
  addedDate: string;
  fileName: string;
  sizeLabel: string;
  // Where the PDF is served from
  url: string;
}

export const mockDocuments: TenantDocument[] = [
  {
    id: "doc_lease_2026",
    title: "Lease Agreement",
    kind: "lease",
    description: "Jan 1, 2026 - Dec 31, 2026",
    addedDate: "Dec 15, 2025",
    fileName: "Lease Agreement - Unit 4B.pdf",
    sizeLabel: "138 KB",
    //Sample Lease with fake data
    url: "/sample-lease.pdf",
  },
];
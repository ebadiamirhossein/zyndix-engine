/** The ten operator areas from brief §3, in the order that section lists them. */
export const DASHBOARD_AREAS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/knowledge", label: "Knowledge & Imports" },
  { href: "/dashboard/products", label: "Products & Proof" },
  { href: "/dashboard/companies", label: "Companies & Contacts" },
  { href: "/dashboard/campaigns", label: "Campaigns & Journeys" },
  { href: "/dashboard/approvals", label: "Approvals" },
  { href: "/dashboard/inbox", label: "Inbox & Tasks" },
  { href: "/dashboard/pipeline", label: "Pipeline" },
  { href: "/dashboard/integrations", label: "Integrations & Health" },
  { href: "/dashboard/reports", label: "Reports & Settings" },
] as const;

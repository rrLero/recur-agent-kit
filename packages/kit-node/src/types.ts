export type MembershipStatus = "active" | "grace" | "expired" | "none";

export type WebhookEventType =
  | "membership.started"
  | "membership.renewed"
  | "membership.grace_started"
  | "membership.expired"
  | "membership.cancelled"
  | "membership.resumed";

export type MembershipEvent = {
  id: string;
  type: WebhookEventType;
  occurredAt: string;
  data: {
    productId: number;
    membership: string;
    member: string;
    status: Exclude<MembershipStatus, "none">;
    source: "paid" | "comp" | "upfront";
    paidUntil: string | null;
    signature: string | null;
    identities: { kind: string; externalId: string }[];
  };
};

export type PingEvent = {
  id: string;
  type: "test.ping";
  occurredAt: string;
  data: Record<string, never>;
};

export type WebhookEvent = MembershipEvent | PingEvent;

export type Access = {
  active: boolean;
  status: MembershipStatus;
  source: "paid" | "comp" | "upfront" | null;
  until: string | null;
  wallet: string | null;
};

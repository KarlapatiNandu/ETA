/** Shapes the admin console reads from /v1/admin/* (Stage 7). */

export type Bus = {
  id: string;
  bus_number: string;
  registration_no: string | null;
  capacity: number | null;
  status: string;
  status_note: string | null;
  default_route_id: string | null;
  current_route_id: string | null;
  route_name: string | null;
  driver_id: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  commission_ticket_id: string | null;
  trackers: {
    device_uid: string;
    kind: string;
    last_seen_at: string | null;
    secret_rotated_at: string | null;
  }[];
};
export type Driver = {
  id: string;
  full_name: string;
  phone_e164: string | null;
  active: boolean;
  buses: string[] | null;
};
export type RouteOption = { id: string; name: string; direction: string };

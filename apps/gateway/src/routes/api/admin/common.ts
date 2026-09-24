import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { t0ConfirmText, type Confirmation, type NotifyEvent } from "@busmitra/contracts";
import { ringNotify, type Keys, type Redis } from "@busmitra/redis";

export const Id = z.object({ id: z.uuid() });

/**
 * Invariant 11, enforced by the server rather than trusted to the UI: a request that notifies
 * anyone must carry the recipient count the admin was shown, and it must still be the count.
 * If the audience moved between the dialog and the click (a student starred the bus, a roster
 * import landed), the admin is shown the new number and asked again — never sent past it.
 * A T0 additionally needs the count typed out.
 *
 * Returns true when the request may proceed; otherwise the reply has been sent.
 */
export function checkConfirmation(
  reply: FastifyReply,
  resolved: number,
  body: Partial<Confirmation>,
  tier: number,
): boolean {
  if (body.confirm_count === undefined) {
    reply.code(428).send({
      error: "confirmation_required",
      message: `This notifies ${resolved} students. Confirm the count to send.`,
      count: resolved,
    });
    return false;
  }
  if (body.confirm_count !== resolved) {
    reply.code(409).send({
      error: "count_changed",
      message: `The audience changed: it is now ${resolved} students, not ${body.confirm_count}. Check and confirm again.`,
      count: resolved,
    });
    return false;
  }
  if (tier === 0 && body.confirm_text?.trim() !== t0ConfirmText(resolved)) {
    reply.code(428).send({
      error: "typed_confirmation_required",
      message: `A critical alert needs the number of students typed out: ${t0ConfirmText(resolved)}.`,
      count: resolved,
    });
    return false;
  }
  return true;
}

/**
 * Ring `stream:notify` after the row it names has committed. Best effort by design: the row is
 * the truth, and the notify worker (Stage 6) sweeps for published rows it was never told about,
 * so a Redis blip delays a notification rather than losing it — and never fails the admin's
 * request after the change is already made.
 */
export async function ring(
  deps: { redis?: Redis; keys?: Keys },
  req: FastifyRequest,
  events: NotifyEvent[],
): Promise<boolean> {
  if (!deps.redis || !deps.keys || !events.length) return false;
  try {
    await ringNotify(deps.redis, deps.keys, events);
    return true;
  } catch (err) {
    req.log.error({ err, events }, "notify doorbell failed; the notify sweep will deliver it");
    return false;
  }
}

export const iso = (d: Date | string | null | undefined) =>
  d == null ? null : new Date(d).toISOString();

export const conflict = (reply: FastifyReply, error: string, message: string) =>
  reply.code(409).send({ error, message });

export const notFound = (reply: FastifyReply, message = "Not found.") =>
  reply.code(404).send({ error: "not_found", message });

/** Postgres unique violation, optionally on a named constraint. */
export const isUnique = (err: unknown, constraint?: string) =>
  (err as { code?: string }).code === "23505" &&
  (!constraint ||
    String((err as { constraint?: string }).constraint ?? (err as Error).message).includes(
      constraint,
    ));

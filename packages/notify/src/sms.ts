/**
 * SMS transport. First used in Stage 4 for claim/recovery OTPs; Stage 6 adds the T0/T1 alert
 * templates and delivery receipts (the provider's request id comes back as `ref`, and the
 * receipt webhook later marks the recipient row delivered).
 *
 * Every message is a DLT-registered template plus variables: Indian operators drop any
 * commercial SMS that does not match an approved template (docs/OUTREACH.md §1).
 */

/** otp: claim/recovery; t0_alert: CRITICAL, always; t1_alert: URGENT when push cannot carry it */
export type SmsTemplate = "otp" | "t0_alert" | "t1_alert";

export interface SmsMessage {
  /** E.164, e.g. +919876543210 */
  to: string;
  template: SmsTemplate;
  vars: Record<string, string>;
}

export interface SmsResult {
  /** the provider's id for this message, matched by the delivery-receipt webhook */
  ref?: string;
}

export interface SmsSender {
  send(msg: SmsMessage): Promise<SmsResult | void>;
}

/** Dev: prints the message instead of sending it. Never used in production (config refuses). */
export function createConsoleSms(log: (line: string) => void = console.log): SmsSender {
  return {
    async send(msg) {
      log(`[sms:console] to=${msg.to} template=${msg.template} ${JSON.stringify(msg.vars)}`);
    },
  };
}

export interface Msg91Options {
  authKey: string;
  /**
   * MSG91 flow/template id per template, each backed by a DLT-approved template. A template
   * without an id cannot be sent (DLT drops unregistered text), so `send` refuses it loudly.
   */
  templateIds: Partial<Record<SmsTemplate, string>>;
  fetch?: typeof fetch;
  endpoint?: string;
}

export class SmsError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`MSG91 rejected the message: HTTP ${status} ${body.slice(0, 200)}`);
    this.name = "SmsError";
    this.status = status;
  }
}

/** MSG91 Flow API (v5). Template variables are named in the MSG91 template (##otp##). */
export function createMsg91Sms(opts: Msg91Options): SmsSender {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? "https://control.msg91.com/api/v5/flow";
  return {
    async send(msg) {
      const templateId = opts.templateIds[msg.template];
      if (!templateId) throw new SmsError(0, `no DLT template configured for ${msg.template}`);
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authkey: opts.authKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          template_id: templateId,
          short_url: "0",
          recipients: [{ mobiles: msg.to.replace(/^\+/, ""), ...msg.vars }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.text();
      // MSG91 answers 200 with {"type":"error"} for template/DLT problems, so check both.
      if (!res.ok || /"type"\s*:\s*"error"/.test(body)) throw new SmsError(res.status, body);
      // success is {"type":"success","message":"<request id>"}
      const ref = /"message"\s*:\s*"([^"]+)"/.exec(body)?.[1];
      return ref ? { ref } : {};
    },
  };
}

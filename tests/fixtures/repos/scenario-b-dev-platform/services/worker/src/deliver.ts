export async function deliver(evt: unknown, attempt = 0) {
  // exponential backoff, max 8 attempts, then dead-letter queue
  // FIXME: no signature header on outbound webhooks yet
}

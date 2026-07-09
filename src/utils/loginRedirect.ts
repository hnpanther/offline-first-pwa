/** After login always land on dashboard — never restore deep links from a prior user session. */
export function postLoginPath(): string {
  return '/'
}

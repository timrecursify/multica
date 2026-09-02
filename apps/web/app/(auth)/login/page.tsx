import { headers } from "next/headers";
import { Suspense } from "react";
import { LoginPageContent } from "./login-page-content";

const SYNTHETIC_TICKETS_HOST = "tickets.synthetic.jp";

function isSyntheticTicketsHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.split(":", 1)[0] ?? "";
  return hostname.toLowerCase().replace(/\.$/, "") === SYNTHETIC_TICKETS_HOST;
}

export default async function Page() {
  const requestHeaders = await headers();
  return (
    <Suspense fallback={null}>
      <LoginPageContent
        isSyntheticTicketsHost={isSyntheticTicketsHost(requestHeaders.get("host"))}
      />
    </Suspense>
  );
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ROLE_HOME, SESSION_COOKIE, parseSession } from "@/lib/auth";

export default async function HomePage() {
  const store = await cookies();
  const session = parseSession(store.get(SESSION_COOKIE)?.value);
  redirect(session ? ROLE_HOME[session.role] : "/login");
}

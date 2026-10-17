import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server-session";
import { PaymentReview } from "@/components/creative/PaymentReview";
export const dynamic = "force-dynamic";
export default async function PaymentReviewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.authRole !== "admin") redirect("/dashboards/operating-network");
  return <PaymentReview />;
}

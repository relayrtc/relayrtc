import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Check } from "lucide-react";
import { PageHeader } from "@/components/page/page-header";
import { Panel } from "@/components/page/panel";
import { SectionHeading } from "@/components/page/setting-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatNumber } from "@/lib/format";
import type { Organization } from "@/lib/mock-data";
import { MONTHLY_FREE_MINUTES, getMonthToDateMinutes } from "@/lib/usage-data";

const plans = [
  {
    name: "Community",
    price: "$0",
    features: [
      `${formatNumber(MONTHLY_FREE_MINUTES)} free participant minutes`,
      "1 project",
      "Community support",
    ],
  },
  {
    name: "Cloud Pro",
    price: "$49",
    features: [
      "150,000 participant minutes",
      "Unlimited projects",
      "Priority support",
      "Audit log and SSO",
    ],
  },
];

const invoices = [
  { id: "INV-0003", date: "Oct 1, 2026", amount: "$0.00", status: "Paid" },
  { id: "INV-0002", date: "Sep 1, 2026", amount: "$0.00", status: "Paid" },
];

export function OrgBilling({ organization }: { organization: Organization }) {
  const used = getMonthToDateMinutes();
  const percent = Math.min(Math.round((used / MONTHLY_FREE_MINUTES) * 100), 100);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Billing"
        description="Manage your plan, payment method and invoices."
        actions={<Button size="lg">Add credits</Button>}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel>
          <p className="text-sm text-muted-foreground">Credit balance</p>
          <p className="text-2xl tracking-tight tabular-nums sm:text-[1.75rem]">$0.00</p>
        </Panel>
        <Panel>
          <p className="text-sm text-muted-foreground">Participant minutes this month</p>
          <p className="text-2xl tracking-tight tabular-nums sm:text-[1.75rem]">
            {formatNumber(used)}
            <span className="text-base text-muted-foreground">
              {" "}
              / {formatNumber(MONTHLY_FREE_MINUTES)}
            </span>
          </p>
          <Progress value={percent} aria-label="Free minutes used" className="mt-3" />
        </Panel>
      </div>

      <section aria-labelledby="plans-heading">
        <SectionHeading>
          <span id="plans-heading">Plan</span>
        </SectionHeading>
        <div className="grid gap-4 md:grid-cols-2">
          {plans.map((plan) => {
            const isCurrent = plan.name === organization.plan;
            return (
              <Panel key={plan.name} className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-medium">{plan.name}</h3>
                  {isCurrent ? <Badge variant="secondary">Current plan</Badge> : null}
                </div>
                <p className="text-2xl tracking-tight">
                  {plan.price}
                  <span className="text-sm text-muted-foreground"> / month</span>
                </p>
                <ul className="grid gap-2 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="size-4 text-success" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  variant={isCurrent ? "outline" : "default"}
                  disabled={isCurrent}
                  className="mt-auto self-start"
                >
                  {isCurrent ? "Current plan" : `Upgrade to ${plan.name}`}
                </Button>
              </Panel>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="invoices-heading">
        <SectionHeading>
          <span id="invoices-heading">Invoices</span>
        </SectionHeading>
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[28rem] text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                <TableHead scope="col" className="py-2 font-normal">
                  Invoice
                </TableHead>
                <TableHead scope="col" className="py-2 font-normal">
                  Date
                </TableHead>
                <TableHead scope="col" className="py-2 font-normal">
                  Amount
                </TableHead>
                <TableHead scope="col" className="py-2 text-right font-normal">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id} className="border-b last:border-0">
                  <TableCell className="py-3.5 font-mono text-[0.8125rem]">{invoice.id}</TableCell>
                  <TableCell className="py-3.5">{invoice.date}</TableCell>
                  <TableCell className="py-3.5 tabular-nums">{invoice.amount}</TableCell>
                  <TableCell className="py-3.5 text-right">
                    <Badge variant="secondary">{invoice.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

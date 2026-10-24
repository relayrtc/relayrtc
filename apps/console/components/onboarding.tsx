"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "./workspace-provider";
import { FooterLinks } from "./app-shell";
import { errorMessage } from "@/lib/account-api";
import { safeRedirect } from "@/lib/auth-query";
import { resourceName } from "@/lib/workspace-api";
import { Button } from "@/ui/button";
import { Icon, Logo } from "@/ui/icon";
import { AuthFrame } from "@/ui/auth-frame";
import { FormFeedback } from "@/ui/auth-fields";

export type OnboardingMode = "organization" | "project" | null;

export function Onboarding({ mode, organizationId, destination = "/rooms" }: { mode: OnboardingMode; organizationId?: string; destination?: string }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [organizationName, setOrganizationName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const organization = workspace.organizations.find(item => item.id === organizationId && item.status === "active") ?? workspace.organization;
  const projectStep = Boolean(organization && (mode === "project" || (mode !== "organization" && !workspace.project)));
  const value = projectStep ? projectName : organizationName;
  const label = projectStep ? "Project" : "Organization";
  useEffect(() => { if (workspace.ready && !pending) input.current?.focus(); }, [workspace.ready, pending, projectStep]);
  useEffect(() => { if (workspace.ready && mode === null && workspace.project) router.replace(safeRedirect(destination)); }, [workspace.ready, workspace.project, mode, destination, router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    try { resourceName(value); } catch (error) { setError(errorMessage(error)); return; }
    lock.current = true; setPending(true); setError("");
    try {
      if (projectStep) { await workspace.createProject(projectName, organization?.id); router.replace(safeRedirect(destination)); }
      else {
        const created = await workspace.createOrganization(organizationName);
        setProjectName(""); router.replace(`/onboarding?new=project&organizationId=${encodeURIComponent(created.id)}&redirect=${encodeURIComponent(safeRedirect(destination))}`);
      }
    } catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setPending(false); }
  }

  if (!workspace.ready) return <AuthFrame title={workspace.error ? "Workspace unavailable" : "Getting your workspace ready"} description="Your organizations and projects are loading."><div className="login-form auth-form"><FormFeedback error={workspace.error} />{workspace.error && <Button onClick={() => void workspace.refreshWorkspace().catch(() => {})}>Try again</Button>}</div></AuthFrame>;
  if (projectStep && !organization?.canManage) return <AuthFrame title="Your team’s projects" description="An organization owner or admin can create a project for you."><div className="login-form auth-form"><Link href="/projects" className="button button-secondary onboarding-continue">View projects</Link><Link href="/organizations" className="auth-text-button">Choose another organization</Link></div></AuthFrame>;

  return <main className="login-page onboarding-page" id="main-content">
    <section className="login-center" aria-label="Workspace onboarding">
      <Logo className="login-logo" /><h1>{projectStep ? "Create your project" : "Create your organization"}</h1>
      <p className="login-subheading">{projectStep ? "Bring your real-time experience to life." : "A home for your team and projects."}</p>
      <div className="onboarding-steps" aria-label={`Step ${projectStep ? 2 : 1} of 2`}><span className={projectStep ? "onboarding-step-complete" : "onboarding-step-current"}>{projectStep ? <Icon name="check" size={11.8125} /> : <span>1</span>}Organization</span><span className="onboarding-step-line" /><span className={projectStep ? "onboarding-step-current" : ""}><span>2</span>Project</span></div>
      {projectStep && <div className="onboarding-organization" title={organization?.name}><Icon name="organization" size={15.246} /><span>{organization?.name}</span></div>}
      <form className="login-form onboarding-form" onSubmit={event => void submit(event)}>
        <label className="sr-only" htmlFor="onboarding-name">{label} name</label>
        <input key={label} ref={input} id="onboarding-name" className="input login-input onboarding-input" placeholder={`${label} name`} value={value} onChange={event => { projectStep ? setProjectName(event.target.value) : setOrganizationName(event.target.value); setError(""); }} autoFocus autoComplete="off" maxLength={120} required aria-invalid={Boolean(error)} aria-describedby={error ? "onboarding-error" : undefined} disabled={pending || workspace.pending} />
        {error && <p id="onboarding-error" className="field-error onboarding-error" role="alert">{error}</p>}
        <Button className="onboarding-continue" variant="primary" type="submit" disabled={!value.trim() || pending || workspace.pending}>{pending ? "Creating…" : projectStep ? "Create Project" : "Continue"}<Icon name="chevronRight" size={17.15175} /></Button>
      </form>
      <p className="onboarding-helper">{projectStep ? "Development and Production environments are created with your project." : "You can add more organizations and projects later."}</p>
      {!!workspace.invitations.length && <Link className="onboarding-back" href="/organizations">Review your invitations</Link>}
      {projectStep && <Link className="onboarding-back" href="/onboarding?new=organization">Create another organization</Link>}
      {!!workspace.organizations.length && <Link className="onboarding-back" href="/organizations">Back to organizations</Link>}
    </section>
    <footer className="login-footer"><p className="login-legal">By continuing, you agree to our <strong>Privacy Policy</strong> and <strong>Terms of Use</strong>.</p><FooterLinks /></footer>
  </main>;
}

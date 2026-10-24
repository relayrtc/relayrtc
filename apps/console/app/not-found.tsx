import { ButtonLink } from "@/ui/button";
import { Logo } from "@/ui/icon";

export default function NotFound() { return <section className="content not-found"><Logo /><h2>This page could not be found.</h2><ButtonLink href="/rooms">Back to Rooms</ButtonLink></section>; }

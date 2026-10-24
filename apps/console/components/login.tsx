"use client";
import { AuthFlow, type AuthParams } from "./auth-flow";
export function Login({ params }: { params?: AuthParams }) { return <AuthFlow mode="login" params={params} />; }

import Image from "next/image";
import { LoginForm } from "./login-form";

export const metadata = { title: "Log in · TMC Document Center" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-sm ring-1 ring-black/5">
        <Image src="/tmc-logo.png" alt="Transmare Chemie" width={295} height={280} className="mx-auto h-auto w-24" priority />
        <h1 className="mt-6 text-center text-lg font-semibold text-tmc">Document Center</h1>
        <LoginForm />
      </div>
    </main>
  );
}

import Link from "next/link";

const TABS = [
  { key: "users", href: "/settings/users", label: "Users" },
  { key: "entities", href: "/settings/entities", label: "Entities" },
] as const;

export function SettingsNav({ current }: { current: (typeof TABS)[number]["key"] }) {
  return (
    <nav className="flex gap-1 border-b border-gray-200 text-sm">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-2 ${t.key === current ? "border-tmc font-semibold text-tmc" : "border-transparent text-gray-600 hover:text-tmc"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

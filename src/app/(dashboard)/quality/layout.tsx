import QualityTabs from "./QualityTabs";

export default function QualityLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <QualityTabs />
      {children}
    </div>
  );
}

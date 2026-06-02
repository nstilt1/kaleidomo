import * as React from "react";
import { cn } from "@/lib/utils";

type TabsContextValue = { active: string; setActive: (v: string) => void };
const TabsContext = React.createContext<TabsContextValue>({ active: "", setActive: () => {} });

interface TabsProps { defaultValue: string; className?: string; children: React.ReactNode; }
function Tabs({ defaultValue, className, children }: TabsProps) {
  const [active, setActive] = React.useState(defaultValue);
  return (
    <TabsContext.Provider value={{ active, setActive }}>
      <div className={cn("flex flex-col min-h-0 h-full", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

function TabsList({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    // sticky so it stays visible when the content below scrolls
    <div className={cn("flex shrink-0 sticky top-0 z-10 bg-card border-b border-border", className)}>
      {children}
    </div>
  );
}

function TabsTrigger({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  const { active, setActive } = React.useContext(TabsContext);
  const isActive = active === value;
  return (
    <button
      type="button"
      onClick={() => setActive(value)}
      className={cn(
        "flex-1 px-2 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
        isActive
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

function TabsContent({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  const { active } = React.useContext(TabsContext);
  if (active !== value) return null;
  // Outer div is the scroll container — it fills remaining aside height
  // Inner div gets the padding/spacing from className
  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className={cn("pb-8", className)}>{children}</div>
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
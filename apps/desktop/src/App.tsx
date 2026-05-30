import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function App() {
  return (
    <TooltipProvider>
      <AppShell />
      <Toaster position="bottom-right" richColors />
    </TooltipProvider>
  );
}

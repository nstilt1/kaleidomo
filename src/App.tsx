import AppContent from "@/components/AppContent"
import { LicenseProvider } from "@/lib/license-context"

export default function App() {
  return (
    <LicenseProvider>
      <AppContent />
    </LicenseProvider>
  )
}
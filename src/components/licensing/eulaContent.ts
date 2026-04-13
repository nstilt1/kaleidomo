import type { EulaSection } from "./EulaModal";

export const EULA_VERSION = "2026-04-12";

export const EULA_SECTIONS: EulaSection[] = [
  {
    title: "1. Acceptance",
    body: [
      'By installing, accessing, or using Kaleidomo ("the Software"), you agree to be bound by this End User License Agreement ("Agreement"). If you do not agree, do not install or use the Software.',
    ],
  },
  {
    title: "2. License Grant",
    body: [
      "Altered Brain Chemistry grants you a limited, non-exclusive, non-transferable license to use the Software.",
      "If the Software requires a license key, usage may be limited based on activation or device restrictions.",
    ],
  },
  {
    title: "3. Ownership",
    body: [
      "The Software is licensed, not sold. All rights not expressly granted are reserved by Altered Brain Chemistry.",
    ],
  },
  {
    title: "4. Licensing System and Device Limits",
    body: [
      "The Software may use a licensing system that associates activations with specific devices.",
      "A license may be limited to a maximum number of activated devices. Device identification is based on system-specific identifiers. Changes to hardware, operating system configuration, or system identifiers may cause a device to be recognized as a new device.",
      'If device changes result in exceeding the activation limit, you may use a "Regenerate" feature to clear all previously activated online devices associated with the license.',
      "Devices activated using offline activation methods, if implemented, cannot be removed through regeneration.",
      "You are responsible for managing your activations and ensuring compliance with the device limit.",
    ],
  },
  {
    title: "5. Server Connectivity and Availability",
    body: [
      "The Software may periodically connect to Altered Brain Chemistry servers for licensing validation and functionality.",
      "The Software may require occasional internet access. Server availability is not guaranteed and may be temporarily unavailable due to maintenance, updates, testing, or unforeseen issues.",
      "Temporary outages may affect licensing verification or functionality, but Altered Brain Chemistry will make reasonable efforts to restore service.",
      "The Software may cease to function after an extended period without successful server communication.",
    ],
  },
  {
    title: "6. Testing, Updates, and Service Changes",
    body: [
      "The licensing system and related services may be updated, modified, or tested over time.",
      "Features may change, improve, or be temporarily unstable during updates. Behavior of licensing, activation, validation, and related systems may evolve.",
    ],
  },
  {
    title: "7. Restrictions",
    body: [
      "You may not redistribute the Software as a standalone product, remove or alter copyright or attribution notices, or use the Software in a manner that circumvents licensing or activation mechanisms.",
    ],
  },
  {
    title: "8. No Warranty",
    body: [
      'The Software is provided "as is" without warranty of any kind, express or implied, including but not limited to fitness for a particular purpose, merchantability, or non-infringement.',
    ],
  },
  {
    title: "9. Limitation of Liability",
    body: [
      "To the maximum extent permitted by law, Altered Brain Chemistry shall not be liable for any indirect, incidental, special, consequential, or exemplary damages, including but not limited to loss of data, loss of profits, or business interruption arising out of or related to the use or inability to use the Software.",
    ],
  },
  {
    title: "10. Changes to This Agreement",
    body: [
      "This Agreement may be updated in future versions of the Software. Continued use of the Software after changes constitutes acceptance of the updated Agreement.",
    ],
  },
];
import type { EulaSection } from "./EulaModal";

export const EULA_VERSION = "2026-06-03";

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
      "Altered Brain Chemistry grants you a limited, non-exclusive, non-transferable license to install and use the Software for personal or commercial creative use, subject to this Agreement and any license tier, activation limit, or product-specific terms that apply to your license.",
      "The Software is licensed, not sold. All rights not expressly granted are reserved by Altered Brain Chemistry.",
    ],
  },
  {
    title: "3. Ownership and User Content",
    body: [
      "Altered Brain Chemistry retains ownership of the Software, including its code, design, interfaces, branding, and related materials, except for third-party components identified in this Agreement or accompanying notices.",
      "You retain ownership of images, audio, video, presets, project files, and other content that you import into or create with the Software, subject to rights held by any third parties in source material you use.",
    ],
  },
  {
    title: "4. Licensing System, Device Limits, and Regeneration",
    body: [
      "The Software may use a licensing system that associates activations with specific devices and periodically validates license status.",
      "A license may be limited to a maximum number of activated devices. Device identification is based on system-specific identifiers. Changes to hardware, operating system configuration, or system identifiers may cause a device to be recognized as a new device.",
      'If device changes result in exceeding the activation limit, you may use a "Regenerate" feature to clear all previously activated online devices associated with the license.',
      "Offline activations are not currently implemented. If offline activation is implemented in the future, devices activated using offline activation methods cannot be removed through regeneration unless Altered Brain Chemistry later provides a separate removal method.",
      "You are responsible for managing your activations and ensuring compliance with the device limit that applies to your license.",
    ],
  },
  {
    title: "5. Server Connectivity, Testing, and Availability",
    body: [
      "The Software may require occasional internet access and may periodically connect to Altered Brain Chemistry servers for license validation, update checks, product information, downloads, and related functionality.",
      "Server availability is not guaranteed and may be temporarily unavailable due to maintenance, updates, testing, or unforeseen issues. Temporary outages may affect licensing verification or related functionality.",
      "The licensing system and related services may be updated, modified, or tested over time. Behavior of licensing, activation, validation, regeneration, and related systems may evolve as the Software and service are improved.",
      "The Software may cease to function after an extended period without successful license validation or server communication, depending on the license rules that apply to your license.",
    ],
  },
  {
    title: "6. Restrictions",
    body: [
      "You may not redistribute the Software as a standalone product, remove or alter copyright or attribution notices, share license keys in violation of the applicable license terms, use the Software to circumvent activation mechanisms, or use the Software in a way that interferes with licensing, security, update, or service infrastructure.",
      "Nothing in this Agreement restricts rights you may have under open-source licenses for third-party components included with the Software, including the right to inspect, modify, or replace those components where the applicable third-party license permits it.",
    ],
  },
  {
    title: "7. FFmpeg and Third-Party Components",
    body: [
      "The Software may include or use FFmpeg, a separate third-party multimedia tool from the FFmpeg project. FFmpeg is not owned by Altered Brain Chemistry.",
      "FFmpeg is licensed under the GNU Lesser General Public License version 2.1 or later when distributed in an LGPL build. FFmpeg source code and license information are available from the FFmpeg project and from any source-code link or third-party notices provided with the Software or on the Software download page.",
      "Third-party open-source components are provided under their own license terms. To the extent this Agreement conflicts with an applicable open-source license, the open-source license governs that component.",
    ],
  },
  {
    title: "8. Updates and Changes",
    body: [
      "The Software may be updated from time to time to add, remove, or modify features, improve compatibility, fix bugs, update dependencies, or change licensing behavior.",
      "This Agreement may be updated in future versions of the Software. Continued use of the Software after changes constitutes acceptance of the updated Agreement.",
    ],
  },
  {
    title: "9. No Warranty",
    body: [
      'The Software is provided "as is" and "as available" without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, title, quiet enjoyment, and non-infringement.',
      "Altered Brain Chemistry does not warrant that the Software will be uninterrupted, error-free, compatible with every file, codec, operating system, graphics device, driver, or third-party dependency, or that generated output will meet every user's requirements.",
    ],
  },
  {
    title: "10. Limitation of Liability",
    body: [
      "To the maximum extent permitted by law, Altered Brain Chemistry shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, including but not limited to loss of data, loss of profits, loss of business, business interruption, loss of goodwill, or costs of substitute goods or services arising out of or related to the Software or inability to use the Software.",
    ],
  },
  {
    title: "11. Termination",
    body: [
      "This Agreement remains in effect until terminated. Your rights under this Agreement terminate automatically if you materially violate this Agreement or applicable license restrictions. Upon termination, you must stop using the Software and uninstall or delete copies under your control, except to the extent you retain rights under applicable third-party open-source licenses.",
    ],
  },
];

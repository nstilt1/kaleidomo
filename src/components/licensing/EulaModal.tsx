export type EulaSection = {
  title: string;
  body: string[];
};

type EulaModalProps = {
  open: boolean;
  version: string;
  productName?: string;
  sections: EulaSection[];
  accepting?: boolean;
  acceptedChecked: boolean;
  onAcceptedCheckedChange: (checked: boolean) => void;
  onAccept: () => void | Promise<void>;
  onDecline: () => void;
  error?: string | null;
  viewOnly?: boolean;
};

export function EulaModal({
  open,
  version,
  productName = "Kaleidomo",
  sections,
  accepting = false,
  acceptedChecked,
  onAcceptedCheckedChange,
  onAccept,
  onDecline,
  error,
  viewOnly = false,
}: EulaModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[1000] bg-white text-black">
      <div className="mx-auto flex h-screen max-w-5xl flex-col p-4 md:p-6">
        <div className="flex h-full flex-col rounded-2xl border bg-white shadow-sm">
          <div className="border-b px-6 py-5">
            <h1 className="text-2xl font-bold md:text-3xl">
              End User License Agreement
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {viewOnly
                ? `Viewing the license agreement for ${productName}.`
                : `Please review and accept the agreement before using ${productName}.`}
            </p>
            <p className="mt-1 text-xs text-gray-500">Version {version}</p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-3xl space-y-8">
              {sections.map((section, index) => (
                <section key={`${section.title}-${index}`} className="space-y-3">
                  <h2 className="text-lg font-semibold">{section.title}</h2>
                  <div className="space-y-3 text-sm leading-6 text-gray-800">
                    {section.body.map((paragraph, paragraphIndex) => (
                      <p key={paragraphIndex}>{paragraph}</p>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>

          <div className="border-t px-6 py-4">
            {!viewOnly ? (
              <label className="flex items-start gap-3 rounded-xl border p-4">
                <input
                  type="checkbox"
                  checked={acceptedChecked}
                  onChange={(e) => onAcceptedCheckedChange(e.target.checked)}
                  disabled={accepting}
                  className="mt-1"
                />
                <span className="text-sm leading-6 text-gray-800">
                  I have read and agree to the End User License Agreement.
                </span>
              </label>
            ) : null}

            {error ? (
              <div className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="rounded-xl border px-4 py-2"
                onClick={onDecline}
                disabled={accepting}
              >
                {viewOnly ? "Close" : "Decline"}
              </button>

              {!viewOnly ? (
                <button
                  type="button"
                  className="rounded-xl border px-4 py-2 font-medium disabled:opacity-50"
                  onClick={() => void onAccept()}
                  disabled={!acceptedChecked || accepting}
                >
                  {accepting ? "Accepting..." : "Accept and Continue"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
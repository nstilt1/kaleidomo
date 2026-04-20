# Tauri + shadcn/ui + Tailwind CSS Boilerplate

A simple desktop app boilerplate with Tauri v2, shadcn/ui, and Tailwind CSS.

## Tech Stack

- **Tauri v2** - Desktop app framework
- **React 18** - Frontend library  
- **TypeScript** - Type safety
- **shadcn/ui** - UI components
- **Tailwind CSS** - Styling
- **Vite** - Build tool

## Quick Start

### Prerequisites
- [Bun](https://bun.sh/) or [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/)

### Installation

```bash
# Clone the repository
git clone https://github.com/wabisabi9547/tauri-shadcn-tailwind-boilerplate.git
cd tauri-shadcn-tailwind-boilerplate

# Install dependencies

# bun
curl -fsSL https://bun.sh/install | bash
# node modules
bun install
# tauri deps
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev

# Start development
bun run tauri:dev

# Build for production
bun run tauri:build
```

## Project Structure

```
src/
├── components/ui/     # shadcn/ui components
├── App.tsx           # Main component
├── main.tsx          # React entry
└── index.css         # Global styles

src-tauri/            # Tauri backend
├── src/              # Rust code
├── Cargo.toml        # Rust deps
└── tauri.conf.json   # Tauri config
```

## Adding Components

```bash
# Add shadcn/ui components
bunx shadcn@latest add button
bunx shadcn@latest add card
```

## License

MIT

## Windows Signing Instructions

1) Obtain a certificate from Microsoft Azure Artifact Signing
2) `cargo install trusted-signing-cli`
3) MS Entra ID>App Registrations>New Registration
  - Name: tauri-signing
  - Single tenant
  - Blank redirect URL
4) Click Register. Copy Application (client) ID and Directory (tenant) ID from the overview page.
5) Certificates & secrets>Client secrets>New client secret
  - Add description and expiration.
  - Add the client secret and immediately copy it. Once you leave the page it will disappear forever.
6) Assign the signing role.
  - Navigate to Artifact Signing Account
  - Go to Access Control (IAM) > Add > Add role assignment
  - Look for and select `Artifact Signing Certificate Profile Signer`
  - Next
  - Assign access to `User, group, or service principal`
  - Click `Select members` and search for the name of the app registration, eg tauri-signing
  - Review + assign
7) Install Azure CLI - `winget install Microsoft.AzureCLI`
8) Add `SIGNTOOL_PATH` to env
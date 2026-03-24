import './globals.css';

export const metadata = {
  title: 'NetSuite App Shell',
  description: 'Future Atlas-backed shell for the NetSuite documentation workspace.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Toaster } from "@/components/ui/toaster";
import { LogoScroller } from "@/components/layout/LogoScroller";
import { Providers } from "@/components/layout/Providers"; // Providers import edildi
import { ClientLayout } from "@/components/layout/ClientLayout";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lottocu - Şansını Dene, Büyük Kazan!",
  description:
    "Lottocu ile heyecan verici çekilişlere katılın ve harika ödüller kazanın.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <Providers>
          <Header />
          <ClientLayout>
            <main>{children}</main>
          </ClientLayout>
          <LogoScroller />
          <Footer />
          <Toaster />
        </Providers>
        
        {/* Test Chatwoot Widget */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(d,t) {
                var BASE_URL="https://app.chatwoot.com";
                var g=d.createElement(t),s=d.getElementsByTagName(t)[0];
                g.src=BASE_URL+"/packs/js/sdk.js";
                g.defer=true;
                g.async=true;
                s.parentNode.insertBefore(g,s);
                g.onload=function(){
                  window.chatwootSDK.run({
                    websiteToken: 'test-token',
                    baseUrl: BASE_URL
                  })
                }
              })(document,"script")
            `
          }}
        />
      </body>
    </html>
  );

}
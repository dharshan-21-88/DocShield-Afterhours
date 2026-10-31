'use client';

/**
 * DocShield workspace shell — fixed sidebar, sticky top bar, view switching,
 * and a footer that stays pinned to the bottom of the viewport.
 */

import { useEffect } from 'react';
import { useDocShield } from '@/lib/docshield/store';
import { Sidebar, TopBar, ViewTransition, WorkflowStepper } from './nav';
import { DashboardView } from './views/dashboard-view';
import { UploadView } from './views/upload-view';
import { StudioView } from './views/studio-view';
import { RiskLensView } from './views/risk-lens-view';
import { VerificationView } from './views/verification-view';
import { ShareView } from './views/share-view';

export function DocShieldApp() {
  const view = useDocShield((s) => s.view);
  const refreshHealth = useDocShield((s) => s.refreshHealth);

  useEffect(() => {
    refreshHealth();
    const timer = setInterval(() => refreshHealth(), 30_000);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <Sidebar />

      <div className="flex min-h-screen flex-col md:pl-64">
        <TopBar />

        <main id="main-content" className="flex-1 px-4 pb-10 pt-5 sm:px-6 lg:px-10">
          <div className="mx-auto max-w-6xl space-y-6">
            <div className="hidden md:block">
              <WorkflowStepper />
            </div>
            <ViewTransition viewKey={view}>
              {view === 'dashboard' && <DashboardView />}
              {view === 'upload' && <UploadView />}
              {view === 'studio' && <StudioView />}
              {view === 'lens' && <RiskLensView />}
              {view === 'verify' && <VerificationView />}
              {view === 'share' && <ShareView />}
            </ViewTransition>
          </div>
        </main>

        <footer className="mt-auto border-t border-border bg-background">
          <div className="mx-auto flex max-w-6xl flex-col gap-1.5 px-4 py-4 text-[11.5px] leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-10">
            <p>
              DocShield uses pattern matching and OCR — detection can miss unusual formats. Always review exports visually.
            </p>
            <p className="shrink-0 sm:text-right">
              A passed verification means automated checks no longer detect the selected values. It is not a guarantee of privacy.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}

import React from 'react';
import { createPortal } from 'react-dom';
import { WorkBoardHeaderSlotsContext, useWorkBoardHeaderSlots } from './workBoardHeaderSlotsContext';

export function WorkBoardHeaderSlotsProvider({ children }: { children: React.ReactNode }) {
  const [projectTabs, setProjectTabs] = React.useState<HTMLElement | null>(null);
  const [sessionTabs, setSessionTabs] = React.useState<HTMLElement | null>(null);
  const value = React.useMemo(() => ({ projectTabs, sessionTabs, setProjectTabs, setSessionTabs }), [projectTabs, sessionTabs]);

  return <WorkBoardHeaderSlotsContext.Provider value={value}>{children}</WorkBoardHeaderSlotsContext.Provider>;
}

export function WorkBoardProjectTabsPortal({ children }: { children: React.ReactNode }) {
  const { projectTabs } = useWorkBoardHeaderSlots();
  return projectTabs ? createPortal(children, projectTabs) : children;
}

export function WorkBoardSessionTabsPortal({ children }: { children: React.ReactNode }) {
  const { sessionTabs } = useWorkBoardHeaderSlots();
  return sessionTabs ? createPortal(
    <div className="app-region-no-drag flex h-full min-w-0 flex-1 items-center" onMouseDown={(event) => event.stopPropagation()}>
      {children}
    </div>,
    sessionTabs,
  ) : children;
}

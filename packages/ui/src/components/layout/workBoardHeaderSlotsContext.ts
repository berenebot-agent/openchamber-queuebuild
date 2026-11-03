import React from 'react';

type WorkBoardHeaderSlots = {
  projectTabs: HTMLElement | null;
  sessionTabs: HTMLElement | null;
  setProjectTabs: (node: HTMLElement | null) => void;
  setSessionTabs: (node: HTMLElement | null) => void;
};

export const WorkBoardHeaderSlotsContext = React.createContext<WorkBoardHeaderSlots>({
  projectTabs: null,
  sessionTabs: null,
  setProjectTabs: () => undefined,
  setSessionTabs: () => undefined,
});

export function useWorkBoardHeaderSlots() {
  return React.useContext(WorkBoardHeaderSlotsContext);
}

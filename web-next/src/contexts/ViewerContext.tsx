import { createContext, type ParentComponent, useContext } from "solid-js";

interface ViewerContextValue {
  isAuthenticated: () => boolean;
  isLoaded: () => boolean;
  id: () => string | undefined;
  username: () => string | undefined;
  moderator: () => boolean;
  /** Whether the signed-in account is under an active moderation suspension. */
  suspended: () => boolean;
  preferAiSummary: () => boolean;
}

export interface ViewerProviderProps {
  isAuthenticated: () => boolean;
  isLoaded: () => boolean;
  id?: () => string | undefined;
  username?: () => string | undefined;
  moderator?: () => boolean;
  suspended?: () => boolean;
  preferAiSummary?: () => boolean;
}

const ViewerContext = createContext<ViewerContextValue>();

export const ViewerProvider: ParentComponent<ViewerProviderProps> = (props) => {
  const value: ViewerContextValue = {
    isAuthenticated: () => props.isAuthenticated(),
    isLoaded: () => props.isLoaded(),
    id: () => props.id?.(),
    username: () => props.username?.(),
    moderator: () => props.moderator?.() ?? false,
    suspended: () => props.suspended?.() ?? false,
    preferAiSummary: () => props.preferAiSummary?.() ?? true,
  };

  return (
    <ViewerContext.Provider value={value}>
      {props.children}
    </ViewerContext.Provider>
  );
};

export function useViewer() {
  const context = useContext(ViewerContext);
  if (!context) {
    throw new Error("useViewer must be used within a ViewerProvider");
  }
  return context;
}

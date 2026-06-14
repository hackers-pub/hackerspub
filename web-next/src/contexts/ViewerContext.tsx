import { createContext, type ParentComponent, useContext } from "solid-js";

interface ViewerContextValue {
  isAuthenticated: () => boolean;
  isLoaded: () => boolean;
  username: () => string | undefined;
  moderator: () => boolean;
  /** Whether the signed-in account is under an active moderation suspension. */
  suspended: () => boolean;
  preferAiSummary: () => boolean;
}

export interface ViewerProviderProps {
  isAuthenticated: () => boolean;
  isLoaded: () => boolean;
  username?: () => string | undefined;
  moderator?: () => boolean;
  suspended?: () => boolean;
  preferAiSummary?: () => boolean;
}

const ViewerContext = createContext<ViewerContextValue>();

export const ViewerProvider: ParentComponent<ViewerProviderProps> = (props) => {
  return (
    <ViewerContext.Provider
      value={{
        isAuthenticated: props.isAuthenticated,
        isLoaded: props.isLoaded,
        username: props.username ?? (() => undefined),
        moderator: props.moderator ?? (() => false),
        suspended: props.suspended ?? (() => false),
        preferAiSummary: props.preferAiSummary ?? (() => true),
      }}
    >
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

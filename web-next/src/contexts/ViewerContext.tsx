import { createContext, type ParentComponent, useContext } from "solid-js";

interface ViewerContextValue {
  isAuthenticated: () => boolean;
  isLoaded: () => boolean;
}

const ViewerContext = createContext<ViewerContextValue>();

export const ViewerProvider: ParentComponent<{
  isAuthenticated: () => boolean;
  isLoaded: () => boolean;
}> = (props) => {
  return (
    <ViewerContext.Provider
      value={{
        isAuthenticated: props.isAuthenticated,
        isLoaded: props.isLoaded,
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

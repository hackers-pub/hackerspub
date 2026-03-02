import { createContext, type ParentComponent, useContext } from "solid-js";

interface ViewerContextValue {
  isAuthenticated: () => boolean;
}

const ViewerContext = createContext<ViewerContextValue>();

export const ViewerProvider: ParentComponent<{
  isAuthenticated: () => boolean;
}> = (props) => {
  return (
    <ViewerContext.Provider
      value={{ isAuthenticated: props.isAuthenticated }}
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

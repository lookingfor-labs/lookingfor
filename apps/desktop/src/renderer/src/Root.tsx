import { useEffect, useState } from "react";
import { App as DemoApp } from "./App";
import { MvpApp } from "./MvpApp";

type ProductRoute = "mvp" | "demo";

function currentRoute(): ProductRoute {
  const pathname = window.location.pathname.replace(/\/+$/u, "") || "/";
  return pathname === "/demo" || window.location.hash === "#/demo" ? "demo" : "mvp";
}

export function Root(): JSX.Element {
  const [route, setRoute] = useState<ProductRoute>(currentRoute);

  useEffect(() => {
    document.body.classList.toggle("mvp-route", route === "mvp");
    document.body.classList.toggle("demo-route", route === "demo");
    const update = () => setRoute(currentRoute());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      document.body.classList.remove("mvp-route", "demo-route");
    };
  }, [route]);

  function navigate(next: ProductRoute): void {
    if (window.location.protocol === "file:") {
      window.location.hash = next === "demo" ? "/demo" : "/";
      return;
    }
    window.history.pushState({}, "", next === "demo" ? "/demo" : "/");
    setRoute(next);
  }

  return route === "demo"
    ? <DemoApp onOpenMvp={() => navigate("mvp")} />
    : <MvpApp onOpenDemo={() => navigate("demo")} />;
}

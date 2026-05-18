import { render } from "preact";
import { Route, Switch } from "wouter-preact";
import { Landing } from "./views/Landing";
import { Guest } from "./views/Guest";
import { Host } from "./views/Host";
import { Admin } from "./views/Admin";
import { Screen } from "./views/Screen";
import "./styles.css";

function App() {
  return (
    <Switch>
      <Route path="/r/:code">{(params) => <Guest code={params.code} />}</Route>
      <Route path="/host/:code">{(params) => <Host code={params.code} />}</Route>
      <Route path="/screen/:code">{(params) => <Screen code={params.code} />}</Route>
      <Route path="/admin">{() => <Admin />}</Route>
      <Route>
        <Landing />
      </Route>
    </Switch>
  );
}

const root = document.getElementById("app")!;
render(<App />, root);

var e=new Map;function i(t,n,u={}){return e.set(t,{handler:n,builtIn:u.builtIn===!0}),()=>{const r=e.get(t);r&&r.handler===n&&e.delete(t)}}function o(t){return e.get(t)}export{i as n,o as t};

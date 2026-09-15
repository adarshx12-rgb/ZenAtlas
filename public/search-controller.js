// Shared by the browser and race-condition tests. Only the current generation can commit UI changes.
export class SearchController {
 constructor(){this.generation=0;this.abort=null;}
 begin(){this.abort?.abort();this.abort=new AbortController();return {generation:++this.generation,signal:this.abort.signal};}
 current(generation){return this.generation===generation;}
 stop(){this.abort?.abort();this.generation++;}
}

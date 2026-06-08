const auth = { username: 'admin', password: '' };

// /api/search queries the shared `site-content` Lucene field that content apps
// contribute to. A bare existdb-openapi install (CI image) has no producer app
// populating `site-content`, so these tests seed their own self-contained
// fixture — a small collection under /db/apps with a `site-content` index — and
// search that. The term "xquery" appears across the fixture; the app id is
// `cypress-search-test`. Setup/teardown run admin XQuery via /api/query.
const APP = 'cypress-search-test';
const TERM = 'xquery';
const DATA = `/db/apps/${APP}/data`;
const CONF = `/db/system/config/db/apps/${APP}/data`;

const SETUP = `
let $xconf :=
  <collection xmlns="http://exist-db.org/collection-config/1.0">
    <index><lucene>
      <analyzer class="org.apache.lucene.analysis.standard.StandardAnalyzer"/>
      <text qname="page">
        <field name="site-content" expression="string-join((title, body)//text(), ' ')"/>
        <field name="site-title" expression="string(title)"/>
        <field name="site-url" expression="string(url)"/>
        <facet dimension="site-app" expression="'${APP}'"/>
        <facet dimension="site-section" expression="string(@section)"/>
      </text>
    </lucene></index>
  </collection>
let $mk := function($n as xs:string, $sec as xs:string, $title as xs:string, $body as xs:string) {
  <page section="{$sec}"><title>{$title}</title><url>/exist/apps/${APP}/{$sec}/{$n}</url><body>{$body}</body></page>
}
let $docs := (
  $mk("p1","guide","XQuery basics","An introduction to XQuery, the query language for XML."),
  $mk("p2","guide","XQuery functions","XQuery has many built-in functions for sequences."),
  $mk("p3","guide","FLWOR in XQuery","The XQuery FLWOR expression iterates and filters."),
  $mk("p4","reference","XQuery modules","Library modules organize reusable XQuery code."),
  $mk("p5","reference","XQuery serialization","Control how XQuery serializes XML and JSON."),
  $mk("p6","reference","XQuery updates","The XQuery update facility modifies stored XML.")
)
return (
  xmldb:create-collection("/db/system/config/db", "apps"),
  xmldb:create-collection("/db/system/config/db/apps", "${APP}"),
  xmldb:create-collection("/db/system/config/db/apps/${APP}", "data"),
  xmldb:store("${CONF}", "collection.xconf", $xconf),
  xmldb:create-collection("/db/apps", "${APP}"),
  xmldb:create-collection("/db/apps/${APP}", "data"),
  (for $d at $i in $docs return xmldb:store("${DATA}", "p" || $i || ".xml", $d)),
  xmldb:reindex("${DATA}"),
  "indexed=" || count(collection("${DATA}")/page)
)[last()]
`;

const TEARDOWN = `
(if (xmldb:collection-available("/db/apps/${APP}")) then xmldb:remove("/db/apps/${APP}") else (),
 if (xmldb:collection-available("/db/system/config/db/apps/${APP}")) then xmldb:remove("/db/system/config/db/apps/${APP}") else (),
 "cleaned")[last()]
`;

function runAdmin(query) {
  return cy.request({ url: '/api/query', method: 'POST', auth, body: { query } }).then(r => {
    // The query runs (and its side effects materialize) on POST; release the cursor.
    if (r.body && r.body.cursor) {
      cy.request({ url: `/api/query/${r.body.cursor}`, method: 'DELETE', auth, failOnStatusCode: false });
    }
  });
}

describe('/api/search', () => {
  before(() => runAdmin(SETUP));
  after(() => runAdmin(TEARDOWN));

  describe('GET /api/search', () => {
    it('requires the q parameter', () => {
      cy.request({ url: '/api/search', auth, failOnStatusCode: false }).then(response => {
        // Missing required query parameter — roaster rejects with 400.
        expect(response.status).to.eq(400);
      });
    });

    it('returns the documented shape: query, total, offset, limit, results', () => {
      cy.request({ url: `/api/search?q=${TERM}&limit=5`, auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('query', TERM);
        expect(response.body).to.have.property('total').that.is.a('number');
        expect(response.body).to.have.property('offset', 0);
        expect(response.body).to.have.property('limit', 5);
        expect(response.body.results).to.be.an('array');
        expect(response.body.total).to.be.greaterThan(0);
      });
    });

    it('orders results by descending relevance score', () => {
      cy.request({ url: `/api/search?q=${TERM}&limit=10`, auth }).then(response => {
        const scores = response.body.results.map(r => r.score);
        scores.forEach(s => expect(s).to.be.a('number').and.to.be.greaterThan(0));
        for (let i = 1; i < scores.length; i++) {
          expect(scores[i]).to.be.at.most(scores[i - 1]);
        }
      });
    });

    it('wraps matched terms in <mark> in snippet and highlights', () => {
      cy.request({ url: `/api/search?q=${TERM}&limit=5`, auth }).then(response => {
        const hit = response.body.results.find(
          r => r.snippet && /<mark>/i.test(r.snippet)
        );
        expect(hit, 'a result with a <mark> snippet').to.exist;
        expect(hit.snippet).to.match(/<mark>.*<\/mark>/i);
        expect(hit.highlights).to.be.an('array');
        expect(hit.highlights.some(h => /<mark>/i.test(h))).to.eq(true);
      });
    });

    it('exposes a canonical document identifier (uri / path)', () => {
      cy.request({ url: `/api/search?q=${TERM}&limit=1`, auth }).then(response => {
        const hit = response.body.results[0];
        expect(hit).to.have.property('uri').that.matches(/^\/db\//);
        expect(hit).to.have.property('path', hit.uri);
        expect(hit).to.have.property('app');
        expect(hit).to.have.property('url');
      });
    });

    it('returns well-formed, single-rooted <span> XML snippets (parse-xml friendly)', () => {
      cy.request({ url: `/api/search?q=${TERM}&limit=5`, auth }).then(response => {
        const isWellFormed = (s) => {
          expect(s, 'fragment is wrapped in a single <span> root').to.match(
            /^<span>[\s\S]*<\/span>$/
          );
          const doc = new DOMParser().parseFromString(s, 'application/xml');
          expect(doc.querySelector('parsererror'), 'fragment parses as XML').to.be.null;
          expect(doc.documentElement.nodeName).to.eq('span');
        };
        response.body.results.forEach(r => {
          isWellFormed(r.snippet);
          r.highlights.forEach(isWellFormed);
        });
      });
    });

    it('returns one result per document (deduplicated)', () => {
      cy.request({ url: `/api/search?q=${TERM}&limit=50`, auth }).then(response => {
        const uris = response.body.results.map(r => r.uri);
        expect(uris.length).to.eq(new Set(uris).size);
      });
    });

    it('pages through results with offset/limit', () => {
      cy.request({ url: `/api/search?q=${TERM}&limit=3&offset=0`, auth }).then(page1 => {
        // Only meaningful when there is more than one page of results.
        if (page1.body.total <= 3) return;
        cy.request({ url: `/api/search?q=${TERM}&limit=3&offset=3`, auth }).then(page2 => {
          expect(page2.body.offset).to.eq(3);
          const u1 = new Set(page1.body.results.map(r => r.uri));
          page2.body.results.forEach(r => expect(u1.has(r.uri)).to.eq(false));
        });
      });
    });

    it('restricts to a single app with the app parameter', () => {
      cy.request({ url: `/api/search?q=${TERM}&app=${APP}&limit=10`, auth }).then(response => {
        expect(response.status).to.eq(200);
        response.body.results.forEach(r => expect(r.app).to.eq(APP));
      });
    });
  });
});

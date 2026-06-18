/* ============================================================
   REGNUM AETERNUM — Legal Information System
   Seed data. Loaded as a plain script (not fetched JSON) so the
   system still works when opened directly from disk, before the
   site is hosted. Replace/extend this as real acts are recorded.

   Shape:
   LEGAL_DATA.acts: [{
     slug, title, shortTitle, aliases[], category, status,
     dateEnacted, dateInForce,
     chapters: [{ id, title, articles: [{
       id, number, title,
       history: [{ version, date, changeNote, text }],   // last entry = current
       crossRefs: [{ actSlug, number, label }],
       caseLawIds: [slug,...]
     }]}]
   }]
   LEGAL_DATA.caseLaw: [{
     slug, refNumber, title, date, court, chamber, subject, type,
     summary, fullText, relatedArticles: [{ actSlug, number }]
   }]

   Cross-references inside article text use the token
   {{ref:act-slug:article-number}} — the renderer turns these into
   clickable links. Status values: "in-force" | "repealed" | "amended".
   ============================================================ */

(function () {
  "use strict";

  var acts = [
    {
      slug: "constitution",
      title: "Constitutio Regni Aeterni",
      shortTitle: "Constitution",
      aliases: ["constitution", "constitutio regni aeterni", "founding charter"],
      category: "constitution",
      status: "in-force",
      dateEnacted: "2025-01-12",
      dateInForce: "2025-01-12",
      chapters: [
        {
          id: "title-1",
          title: "Title I — Fundamental Principles",
          articles: [
            {
              id: "art-1", number: 1, title: "Sovereignty",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "Sovereignty of Regnum Aeternum resides in the Crown and is exercised on behalf of the Crown by its lawful organs, in accordance with this Constitution and the Acts made thereunder. No authority within the realm may act outside the powers granted to it by law." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-2", number: 2, title: "Territory",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "The territory of Regnum Aeternum comprises all land claimed and registered under the Land Registry System, together with such further territory as the Crown may lawfully acquire or recognise." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-3", number: 3, title: "Symbols of the Realm",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "The Crest, the Flag, and the motto \u201cRegnum quod non cadit\u201d are the official symbols of the realm and shall be afforded due respect in all proceedings of state." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        },
        {
          id: "title-2",
          title: "Title II — The Crown",
          articles: [
            {
              id: "art-4", number: 4, title: "The Crown",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "The Crown is the supreme authority of Regnum Aeternum. It is the source of executive power, the fount of justice, and the guarantor of this Constitution." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-5", number: 5, title: "Powers of the Crown",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "The Crown may issue decrees, appoint officers of state, grant clearance to restricted offices, and exercise such further powers as are necessary to the good governance of the realm, subject to the limits set out in this Constitution." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        },
        {
          id: "title-3",
          title: "Title III — Rights and Duties of Citizens",
          articles: [
            {
              id: "art-6", number: 6, title: "Citizenship",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "Citizenship of Regnum Aeternum is granted to those recognised by the Crown's administrators and recorded in the civil registry. Citizenship may be revoked only by lawful process." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-7", number: 7, title: "Civil Rights",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "Every citizen is entitled to equal protection of the law, to hold and register property under the Land Registry System, and to access the public offices of the realm on equal terms." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-8", number: 8, title: "Duties of Citizens",
              history: [{ version: 1, date: "2025-01-12", changeNote: "Original text.",
                text: "Every citizen owes the realm fidelity, lawful conduct, and the truthful registration of claims and holdings made under the offices of state." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        }
      ]
    },

    {
      slug: "judicial-power",
      title: "Act of 24 June, 2025 on the Judicial Power and Its Organs",
      shortTitle: "Judicial Power Act",
      aliases: ["judicial power act", "judiciary act", "judicial power"],
      category: "act",
      status: "in-force",
      dateEnacted: "2025-06-24",
      dateInForce: "2025-06-24",
      chapters: [
        {
          id: "ch-1",
          title: "Chapter I — The Supreme Court",
          articles: [
            {
              id: "art-1", number: 1, title: "Establishment of the Supreme Court",
              history: [{ version: 1, date: "2025-06-24", changeNote: "Original text.",
                text: "There is established a Supreme Court of Regnum Aeternum, which shall be the highest judicial authority of the realm and the final interpreter of the Constitution and the Acts made under it." }],
              crossRefs: [{ actSlug: "constitution", number: 1, label: "Constitution, Art. 1" }],
              caseLawIds: []
            },
            {
              id: "art-2", number: 2, title: "Composition and Chambers",
              history: [{ version: 1, date: "2025-06-24", changeNote: "Original text.",
                text: "The Supreme Court shall sit in such Chambers as the Crown may establish, including a Civil Chamber and a Criminal Chamber, each competent to hear matters within its assigned jurisdiction." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-3", number: 3, title: "Jurisdiction",
              history: [{ version: 1, date: "2025-06-24", changeNote: "Original text.",
                text: "The Supreme Court has jurisdiction over disputes between citizens, disputes between citizens and the offices of state, and such criminal matters as are referred to it under the Penal Code." }],
              crossRefs: [{ actSlug: "penal-code", number: 1, label: "Penal Code, Art. 1" }],
              caseLawIds: []
            }
          ]
        },
        {
          id: "ch-2",
          title: "Chapter II — Judicial Proceedings",
          articles: [
            {
              id: "art-4", number: 4, title: "Commencement of Proceedings",
              history: [{ version: 1, date: "2025-06-24", changeNote: "Original text.",
                text: "Proceedings before the Supreme Court are commenced by the filing of a petition with the Civil Office, identifying the parties, the relief sought, and the provisions of law relied upon." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-5", number: 5, title: "Right to Appeal",
              history: [{ version: 1, date: "2025-06-24", changeNote: "Original text.",
                text: "A party dissatisfied with a ruling of a Chamber of the Supreme Court may petition the Crown for review, within such time as the Court's procedures prescribe." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        }
      ]
    },

    {
      slug: "penal-code",
      title: "Act of 15 May, 2026 - Penal Code of Regnum Aeternum",
      shortTitle: "Penal Code",
      aliases: ["penal code", "criminal code"],
      category: "code",
      status: "in-force",
      dateEnacted: "2026-05-15",
      dateInForce: "2026-05-15",
      chapters: [
        {
          id: "ch-1",
          title: "Chapter I — General Provisions",
          articles: [
            {
              id: "art-1", number: 1, title: "Definition of Offence",
              history: [{ version: 1, date: "2026-05-15", changeNote: "Original text.",
                text: "An offence is any act or omission declared punishable by this Code or by another Act of the realm." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-2", number: 2, title: "Principle of Legality",
              history: [{ version: 1, date: "2026-05-15", changeNote: "Original text.",
                text: "No person shall be punished for an act or omission that was not, at the time it was committed, declared an offence by law." }],
              crossRefs: [], caseLawIds: []
            },
            {
              id: "art-3", number: 3, title: "Penalties",
              history: [
                { version: 1, date: "2026-05-15", changeNote: "Original text.",
                  text: "Penalties under this Code include censure, fine, restriction of access to the offices of state, and banishment, as the gravity of the offence requires." },
                { version: 2, date: "2026-06-10", changeNote: "Added confiscation of unlawfully held property as a penalty, following the ruling in SC-2026-001.",
                  text: "Penalties under this Code include censure, fine, confiscation of unlawfully held property, restriction of access to the offices of state, and banishment, as the gravity of the offence requires." }
              ],
              crossRefs: [], caseLawIds: ["sc-2026-001"]
            }
          ]
        },
        {
          id: "ch-2",
          title: "Chapter II — Crimes Against the Crown",
          articles: [
            {
              id: "art-4", number: 4, title: "Treason",
              history: [{ version: 1, date: "2026-05-15", changeNote: "Original text.",
                text: "Any citizen who takes up arms against the Crown, or who knowingly aids a hostile power against the realm, commits treason and is liable to the most severe penalties available under {{ref:penal-code:3}}." }],
              crossRefs: [{ actSlug: "penal-code", number: 3, label: "Penal Code, Art. 3" }],
              caseLawIds: []
            },
            {
              id: "art-5", number: 5, title: "Insult to the Crown",
              history: [{ version: 1, date: "2026-05-15", changeNote: "Original text.",
                text: "Any person who publicly insults the Crown, as defined in {{ref:constitution:4}} and {{ref:constitution:5}}, commits an offence and is liable to censure or fine." }],
              crossRefs: [
                { actSlug: "constitution", number: 4, label: "Constitution, Art. 4" },
                { actSlug: "constitution", number: 5, label: "Constitution, Art. 5" }
              ],
              caseLawIds: []
            }
          ]
        }
      ]
    },

    {
      slug: "war-policy",
      title: "Act of 23 May, 2026 on the War Policy of Regnum Aeternum",
      shortTitle: "War Policy Act",
      aliases: ["war policy act", "war policy"],
      category: "act",
      status: "in-force",
      dateEnacted: "2026-05-23",
      dateInForce: "2026-06-07",
      chapters: [
        {
          id: "ch-1",
          title: "Chapter I — General Provisions",
          articles: [
            {
              id: "art-1", number: 1, title: "Declaration of War",
              history: [{ version: 1, date: "2026-05-23", changeNote: "Original text.",
                text: "A state of war between Regnum Aeternum and another power may be declared only by decree of the Crown, and shall be recorded in the Times of Regnum without delay." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        }
      ]
    },

    {
      slug: "democratization-public-life",
      title: "Act of 26 October, 2025 on the Democratization of Public Life",
      shortTitle: "Democratization Act",
      aliases: ["democratization act", "democratisation act"],
      category: "act",
      status: "in-force",
      dateEnacted: "2025-10-26",
      dateInForce: "2025-10-26",
      chapters: [
        {
          id: "ch-1",
          title: "Chapter I — Public Participation",
          articles: [
            {
              id: "art-1", number: 1, title: "Public Assemblies",
              history: [{ version: 1, date: "2025-10-26", changeNote: "Original text.",
                text: "Citizens may assemble peaceably to discuss matters of state, provided that such assembly does not obstruct the lawful functions of the offices of the realm." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        }
      ]
    },

    {
      slug: "general-taxation",
      title: "Act of 23 June, 2025 on General Taxation of Regnum Aeternum",
      shortTitle: "Taxation Act",
      aliases: ["taxation act", "general taxation"],
      category: "act",
      status: "in-force",
      dateEnacted: "2025-06-23",
      dateInForce: "2025-06-23",
      chapters: [
        {
          id: "ch-1",
          title: "Chapter I — General Provisions",
          articles: [
            {
              id: "art-1", number: 1, title: "General Levy",
              history: [{ version: 1, date: "2025-06-23", changeNote: "Original text.",
                text: "A general levy may be imposed upon citizens and holdings of the realm by decree of the Treasury, published in advance in the Times of Regnum." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        }
      ]
    },

    {
      slug: "national-economic-framework",
      title: "Act of 20 June, 2025 on National Economic Framework of Regnum Aeternum",
      shortTitle: "Economic Framework Act",
      aliases: ["economic framework act", "national economic framework"],
      category: "act",
      status: "in-force",
      dateEnacted: "2025-06-20",
      dateInForce: "2025-06-20",
      chapters: [
        {
          id: "ch-1",
          title: "Chapter I — General Provisions",
          articles: [
            {
              id: "art-1", number: 1, title: "Coinage",
              history: [{ version: 1, date: "2025-06-20", changeNote: "Original text.",
                text: "The coin of the realm is issued under the authority of the Treasury and is legal tender for all debts and dues within Regnum Aeternum." }],
              crossRefs: [], caseLawIds: []
            }
          ]
        }
      ]
    },

    {
      slug: "property-code",
      title: "Act of 8 March, 2025 - Property Code of Regnum Aeternum",
      shortTitle: "Property Code",
      aliases: ["property code"],
      category: "code",
      status: "in-force",
      dateEnacted: "2025-03-08",
      dateInForce: "2025-03-08",
      chapters: [
        {
          id: "ch-1",
          title: "Chapter I — General Provisions",
          articles: [
            {
              id: "art-1", number: 1, title: "Right of Property",
              history: [{ version: 1, date: "2025-03-08", changeNote: "Original text.",
                text: "Every citizen has the right to hold, register, and dispose of property recognised under the Land Registry System, subject to lawful seizure only by order of the Supreme Court." }],
              crossRefs: [{ actSlug: "judicial-power", number: 1, label: "Judicial Power Act, Art. 1" }],
              caseLawIds: ["sc-2026-001"]
            }
          ]
        }
      ]
    }
  ];

  var caseLaw = [
    {
      slug: "sc-2026-001",
      refNumber: "SC-2026-001",
      title: "State Treasury v. John Calderhill",
      date: "2026-01-15",
      court: "Supreme Court of Regnum Aeternum",
      chamber: "Civil Chamber",
      subject: "Property — unlawful seizure",
      type: "Judgment",
      summary: "The Court held that property seized without a prior order of the Supreme Court was unlawfully taken, ordered its return, and recommended that confiscation be added as an available penalty for future cases of unlawfully held property.",
      fullText: "The State Treasury sought confirmation of its seizure of certain holdings registered to John Calderhill, citing an administrative order issued without prior judicial sanction. The Civil Chamber held that Article 1 of the Property Code permits seizure of property only by order of the Supreme Court, and that no such order had been sought or obtained prior to the seizure. The Chamber therefore declared the seizure unlawful and ordered the restoration of the holdings to the respondent. The Chamber further noted, in obiter, that the Crown's officers should consider whether confiscation ought to be added as an available penalty under the Penal Code for future cases of unlawfully held property — a recommendation subsequently adopted in the amended Article 3 of the Penal Code.",
      relatedArticles: [
        { actSlug: "property-code", number: 1 },
        { actSlug: "penal-code", number: 3 }
      ]
    }
  ];

  window.LEGAL_DATA = { acts: acts, caseLaw: caseLaw };
})();

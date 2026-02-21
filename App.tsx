
import React, { useState, useMemo, useEffect, useCallback, useDeferredValue } from 'react';
import { ServiceItem, MaterialItem, AppView } from './types';
import { parseFile } from './parser';
import { db } from './db';
import { getSmartExpansion, SearchExpansion } from './geminiService';
import MiniSearch from 'minisearch';

const STOP_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'para', 'com', 'em', 'na', 'no', 'ou', 'e', 'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'por']);

const LOCAL_URLS = {
  catser: '/data/Lista_CATSER_CORRIGIDA.xlsx',
  catmat: '/data/Lista_CATMAT.xlsx'
};

const toSentenceCase = (str: string) => {
  if (!str) return '';
  const lower = str.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

export default function App() {
  const [view, setView] = useState<AppView | 'syncing'>('syncing');
  const [catserCatalog, setCatserCatalog] = useState<ServiceItem[]>([]);
  const [catmatCatalog, setCatmatCatalog] = useState<MaterialItem[]>([]);
  
  // Estados de busca
  const [searchInput, setSearchInput] = useState('');
  const deferredSearchTerm = useDeferredValue(searchInput);
  const [filterGroup, setFilterGroup] = useState('Todos');
  
  // Estados da IA e Filtros Semânticos
  const [expansion, setExpansion] = useState<SearchExpansion | null>(null);
  const [activeExpansionTerms, setActiveExpansionTerms] = useState<string[]>([]);
  const [isExpanding, setIsExpanding] = useState(false);
  
  const [syncTarget, setSyncTarget] = useState<'CATSER' | 'CATMAT' | null>(null);
  const [syncPhase, setSyncPhase] = useState<'idle' | 'downloading' | 'parsing' | 'saving'>('idle');
  const [progress, setProgress] = useState(0);
  
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(15);

  const sortDataByCode = (data: any[], key: string) => {
    return [...data].sort((a, b) => {
      const valA = String(a[key] || '');
      const valB = String(b[key] || '');
      const numA = parseInt(valA, 10);
      const numB = parseInt(valB, 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return valA.localeCompare(valB);
    });
  };

  const downloadAndProcess = useCallback(async (type: 'catser' | 'catmat') => {
    const url = LOCAL_URLS[type];
    setSyncTarget(type.toUpperCase() as any);
    setSyncPhase('downloading');
    setProgress(0);

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Falha ao ler arquivo local (${response.status})`);

      const contentLength = +(response.headers.get('Content-Length') || 0);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Falha ao ler dados.');

      let receivedLength = 0;
      let chunks = [];

      while(true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        if (contentLength) {
          setProgress(Math.round((receivedLength / contentLength) * 100));
        } else {
          setProgress(Math.min(99, Math.round((receivedLength / 105000000) * 100)));
        }
      }

      setSyncPhase('parsing');
      setProgress(100);
      
      const blob = new Blob(chunks);
      const buffer = await blob.arrayBuffer();
      const isMat = type === 'catmat';
      let data = parseFile(buffer, isMat);

      if (data && data.length > 0) {
        setSyncPhase('saving');
        const sortedData = sortDataByCode(data, isMat ? 'codigoMaterial' : 'codigoServico');
        
        if (isMat) {
          setCatmatCatalog(sortedData);
          await db.saveCatalog('catmat', sortedData);
        } else {
          setCatserCatalog(sortedData);
          await db.saveCatalog('catser', sortedData);
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error(`Erro ao processar ${type}:`, err);
      return false;
    } finally {
      setSyncPhase('idle');
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      const cachedSer = await db.getCatalog('catser');
      const cachedMat = await db.getCatalog('catmat');
      
      if (cachedSer) setCatserCatalog(cachedSer);
      if (cachedMat) setCatmatCatalog(cachedMat);

      if (!cachedSer) {
        setView('syncing');
        await downloadAndProcess('catser');
      }
      if (!cachedMat) {
        setView('syncing');
        await downloadAndProcess('catmat');
      }
      
      const finalSer = cachedSer || await db.getCatalog('catser');
      if (finalSer) setView('catser');
    };
    init();
  }, [downloadAndProcess]);

  // Efeito para disparar a IA e gerenciar as tags ativas
  useEffect(() => {
    const term = deferredSearchTerm.trim();
    if (term.length < 3) {
      setExpansion(null);
      setActiveExpansionTerms([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsExpanding(true);
      const result = await getSmartExpansion(term);
      if (result) {
        setExpansion(result);
        // Ativa o termo original + os sugeridos pela IA
        setActiveExpansionTerms([term, ...result.synonyms, ...result.categories]);
      } else {
        setExpansion(null);
        setActiveExpansionTerms([term]);
      }
      setIsExpanding(false);
    }, 800);
    return () => clearTimeout(timer);
  }, [deferredSearchTerm]);

  const normalize = (text: string) => 
    text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  const toggleTerm = (term: string) => {
    setActiveExpansionTerms(prev => 
      prev.includes(term) ? prev.filter(t => t !== term) : [...prev, term]
    );
    setCurrentPage(1);
  };

  const currentCatalog = useMemo(() => {
    return view === 'catser' ? catserCatalog : catmatCatalog;
  }, [view, catserCatalog, catmatCatalog]);

  // Cálculo de termos com contagem e ordenação decrescente (incluindo o original)
  const expansionTermsWithCounts = useMemo(() => {
    const baseTerm = deferredSearchTerm.trim();
    if (!baseTerm || currentCatalog.length === 0) return [];
    
    const aiTerms = expansion ? [...expansion.synonyms, ...expansion.categories] : [];
    const uniqueMap = new Map<string, string>();
    
    [baseTerm, ...aiTerms].forEach(t => {
      if (t.trim().length > 2) {
        const norm = normalize(t);
        if (!uniqueMap.has(norm)) uniqueMap.set(norm, t);
      }
    });
    
    const allUniquePotentialTerms = Array.from(uniqueMap.values());
    const countsMap: Record<string, number> = {};
    const normalizedList = allUniquePotentialTerms.map(t => ({ original: t, normalized: normalize(t) }));
    
    const catalogInGroup = filterGroup === 'Todos' 
      ? currentCatalog 
      : currentCatalog.filter(i => i.grupoDescricao === filterGroup);

    catalogInGroup.forEach(item => {
      const itemText = normalize(Object.values(item).join(' '));
      normalizedList.forEach(t => {
        if (itemText.includes(t.normalized)) {
          countsMap[t.original] = (countsMap[t.original] || 0) + 1;
        }
      });
    });

    return normalizedList
      .map(t => ({ term: t.original, count: countsMap[t.original] || 0 }))
      .filter(t => t.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [expansion, currentCatalog, filterGroup, deferredSearchTerm]);

  // Criação dos Índices Invertidos (MiniSearch) imediatamente após carga em memória
  const catserIndex = useMemo(() => {
    const miniSearch = new MiniSearch({
      idField: 'codigoServico',
      fields: ['descricaoServico', 'classeDescricao', 'grupoDescricao'],
      storeFields: ['codigoServico', 'grupoDescricao'],
      searchOptions: {
        boost: { descricaoServico: 3, classeDescricao: 1, grupoDescricao: 1 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'OR'
      },
      tokenize: (string) => string.toLowerCase().split(/[\s\-]+/).filter(token => token.length > 2 && !STOP_WORDS.has(token)),
      processTerm: (term) => term.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    });
    if (catserCatalog.length > 0) miniSearch.addAll(catserCatalog);
    return miniSearch;
  }, [catserCatalog]);

  const catmatIndex = useMemo(() => {
    const miniSearch = new MiniSearch({
      idField: 'codigoMaterial',
      fields: ['descricaoMaterial', 'classeDescricao', 'grupoDescricao'],
      storeFields: ['codigoMaterial', 'grupoDescricao'],
      searchOptions: {
        boost: { descricaoMaterial: 3, classeDescricao: 1, grupoDescricao: 1 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'OR'
      },
      tokenize: (string) => string.toLowerCase().split(/[\s\-]+/).filter(token => token.length > 2 && !STOP_WORDS.has(token)),
      processTerm: (term) => term.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    });
    if (catmatCatalog.length > 0) miniSearch.addAll(catmatCatalog);
    return miniSearch;
  }, [catmatCatalog]);

  const currentCatalogMap = useMemo(() => {
    const map = new Map<string, any>();
    const isMat = view === 'catmat';
    const idField = isMat ? 'codigoMaterial' : 'codigoServico';
    for (const item of currentCatalog) {
      map.set(String(item[idField]), item);
    }
    return map;
  }, [currentCatalog, view]);

  // Filtragem e RANKING por relevância com MiniSearch (BM25)
  const filteredData = useMemo(() => {
    if (view === 'syncing') return [];

    if (activeExpansionTerms.length === 0) {
      if (filterGroup === 'Todos') return currentCatalog;
      return currentCatalog.filter(item => item.grupoDescricao === filterGroup);
    }

    const currentSearchIndex = view === 'catser' ? catserIndex : catmatIndex;

    const queries = activeExpansionTerms.map(term => {
      const isOriginal = normalize(term) === normalize(deferredSearchTerm);
      return {
        queries: [term],
        boost: isOriginal ? 5 : 1
      };
    });

    const searchResults = currentSearchIndex.search({
      combineWith: 'OR',
      queries
    }, {
      filter: (result) => filterGroup === 'Todos' || result.grupoDescricao === filterGroup
    });

    const mapped = [];
    for (const res of searchResults) {
      const item = currentCatalogMap.get(String(res.id));
      if (item) mapped.push(item);
    }

    return mapped;
  }, [currentCatalog, currentCatalogMap, view, catserIndex, catmatIndex, activeExpansionTerms, deferredSearchTerm, filterGroup]);

  // Checagem se existem resultados na OUTRA aba para o aviso de erro
  const existsInOtherCatalog = useMemo(() => {
    if (filteredData.length > 0 || deferredSearchTerm.trim().length < 3) return false;
    
    const otherIndex = view === 'catser' ? catmatIndex : catserIndex;
    const queries = activeExpansionTerms.length > 0 ? activeExpansionTerms : [deferredSearchTerm];
    
    const results = otherIndex.search({
      combineWith: 'OR',
      queries: queries.map(q => ({ queries: [q] }))
    });
    
    return results.length > 0;
  }, [filteredData, view, catserIndex, catmatIndex, activeExpansionTerms, deferredSearchTerm]);

  const groups = useMemo(() => {
    const set = new Set(currentCatalog.map(i => i.grupoDescricao));
    return ['Todos', ...Array.from(set)].filter(Boolean).sort();
  }, [currentCatalog]);

  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredData.slice(start, start + itemsPerPage);
  }, [filteredData, currentPage, itemsPerPage]);

  const totalPages = Math.ceil(filteredData.length / itemsPerPage);

  const PaginationControls = ({ discrete = false }: { discrete?: boolean }) => {
    if (totalPages <= 1) return null;
    return (
      <div className={`flex items-center gap-1 ${discrete ? '' : 'mt-12 justify-center gap-2'}`}>
        <button 
          disabled={currentPage === 1}
          onClick={() => {setCurrentPage(p => p - 1); window.scrollTo(0,0)}}
          className={`${discrete ? 'w-8 h-8 rounded-lg' : 'px-6 py-3 rounded-xl'} bg-white border border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-400 disabled:opacity-30 hover:bg-slate-50 transition-all flex items-center justify-center`}
        >
          {discrete ? <i className="fas fa-chevron-left text-[8px]"></i> : 'Anterior'}
        </button>
        <div className={`${discrete ? 'px-2 text-slate-400 font-bold text-[10px]' : 'px-6 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest'}`}>
          {discrete ? `${currentPage} / ${totalPages}` : `Pág. ${currentPage} / ${totalPages}`}
        </div>
        <button 
          disabled={currentPage === totalPages}
          onClick={() => {setCurrentPage(p => p + 1); window.scrollTo(0,0)}}
          className={`${discrete ? 'w-8 h-8 rounded-lg' : 'px-6 py-3 rounded-xl'} bg-white border border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-400 disabled:opacity-30 hover:bg-slate-50 transition-all flex items-center justify-center`}
        >
          {discrete ? <i className="fas fa-chevron-right text-[8px]"></i> : 'Próxima'}
        </button>
      </div>
    );
  };

  const isService = view === 'catser';
  const themeColor = isService ? 'blue' : 'emerald';
  const themeClass = isService ? 'bg-blue-600 shadow-blue-100' : 'bg-emerald-600 shadow-emerald-100';

  const handleRefresh = async () => {
    if (confirm('Deseja recarregar os catálogos agora? Isso refará a importação das planilhas internas.')) {
        await db.clear();
        window.location.reload();
    }
  };

  if (view === 'syncing') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6 text-white">
        <div className="max-w-md w-full text-center">
          <div className="mb-10 relative inline-block">
             <div className="w-24 h-24 bg-blue-600 rounded-3xl flex items-center justify-center text-4xl shadow-2xl animate-pulse">
                <i className="fas fa-database"></i>
             </div>
          </div>
          <h1 className="text-3xl font-black tracking-tighter mb-2">Preparando Catálogos</h1>
          <p className="text-slate-400 font-medium mb-12 text-sm px-4">Sincronizando banco de dados SIASG atualizado.</p>
          <div className="bg-slate-800/50 p-8 rounded-[2rem] border border-slate-700/50 backdrop-blur-xl">
             <div className="flex justify-between items-end mb-4 px-1">
                <div className="text-left">
                   <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Processo</p>
                   <p className="text-sm font-bold text-white uppercase">{syncPhase} {syncTarget}</p>
                </div>
                <p className="text-2xl font-black text-white tabular-nums">{progress}%</p>
             </div>
             <div className="w-full bg-slate-700 h-3 rounded-full overflow-hidden mb-2">
                <div className="bg-blue-500 h-full transition-all duration-300 ease-out" style={{ width: `${progress}%` }}></div>
             </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <nav className="bg-white h-20 px-8 flex items-center justify-between border-b border-slate-100 sticky top-0 z-50 shadow-sm">
        <div className="flex items-center gap-8">
          <div className="flex flex-col">
            <h1 className="text-lg font-black text-slate-900 leading-none tracking-tight uppercase">Pesquisa Inteligente</h1>
            <span className={`text-[9px] font-bold text-${themeColor}-500 uppercase tracking-widest mt-1`}>CATMAT & CATSER</span>
          </div>
          <div className="h-8 w-[1px] bg-slate-100"></div>
          <div className="flex gap-2">
            <button onClick={() => {setView('catser'); setCurrentPage(1)}} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isService ? `bg-blue-600 text-white shadow-lg shadow-blue-100` : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}>
              Serviços ({catserCatalog.length})
            </button>
            <button onClick={() => {setView('catmat'); setCurrentPage(1)}} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!isService ? `bg-emerald-600 text-white shadow-lg shadow-emerald-100` : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}>
              Materiais ({catmatCatalog.length})
            </button>
          </div>
        </div>
        <button onClick={handleRefresh} className="text-slate-400 hover:text-blue-500 transition-colors p-2" title="Atualizar Banco de Dados">
          <i className="fas fa-sync-alt"></i>
        </button>
      </nav>

      <main className="max-w-7xl w-full mx-auto p-8 flex-1">
        <div className="flex flex-col gap-4 mb-8">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative group">
              <i className={`fas ${isExpanding ? `fa-circle-notch animate-spin text-${themeColor}-500` : `fa-search text-slate-300`} absolute left-6 top-1/2 -translate-y-1/2 group-focus-within:text-${themeColor}-500 transition-colors`}></i>
              <input 
                type="text" 
                placeholder={`Pesquisar ${isService ? 'serviços' : 'materiais'}...`}
                value={searchInput}
                onChange={e => {setSearchInput(e.target.value); setCurrentPage(1)}}
                className={`w-full bg-white border-2 border-slate-100 rounded-2xl pl-16 pr-6 py-5 text-lg font-medium outline-none focus:border-${themeColor}-500 transition-all shadow-sm`}
              />
              {isExpanding && (
                <div className="absolute right-6 top-1/2 -translate-y-1/2 flex items-center gap-2">
                   <span className={`px-3 py-1 bg-${themeColor}-50 text-${themeColor}-600 text-[10px] font-black uppercase rounded-lg border border-${themeColor}-100`}>
                     Ranking Inteligente...
                   </span>
                </div>
              )}
            </div>
            <div className="md:w-72">
              <select 
                value={filterGroup}
                onChange={e => {setFilterGroup(e.target.value); setCurrentPage(1)}}
                className="w-full bg-white border-2 border-slate-100 rounded-2xl px-6 py-5 font-bold text-slate-600 outline-none appearance-none cursor-pointer shadow-sm"
              >
                {groups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>
          
          {expansionTermsWithCounts.length > 0 && (
            <div className="bg-white border border-slate-100 p-6 rounded-2xl shadow-sm">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                  <i className="fas fa-sort-amount-down text-blue-500"></i>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    Palavras-chave Ativas (Itens com mais matches aparecem primeiro):
                  </span>
                </div>
                <div className="flex gap-4">
                  <button onClick={() => setActiveExpansionTerms(expansionTermsWithCounts.map(t => t.term))} className="text-[9px] font-black text-blue-600 hover:underline uppercase tracking-widest">Ativar Todas</button>
                  <button onClick={() => setActiveExpansionTerms([])} className="text-[9px] font-black text-slate-400 hover:text-red-500 uppercase tracking-widest">Desmarcar</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2.5">
                {expansionTermsWithCounts.map(({ term, count }, i) => {
                  const isActive = activeExpansionTerms.includes(term);
                  const isOriginal = normalize(term) === normalize(deferredSearchTerm);
                  
                  return (
                    <button 
                      key={i} 
                      onClick={() => toggleTerm(term)}
                      className={`px-4 py-2.5 text-[10px] font-bold rounded-xl border transition-all flex items-center gap-2.5 ${isActive 
                        ? (isOriginal ? 'bg-slate-900 border-slate-900 text-white shadow-lg ring-2 ring-slate-200' : 'bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-100')
                        : 'bg-slate-50 border-slate-100 text-slate-400 hover:bg-slate-200'}`}
                    >
                      <span className="flex items-center gap-2">
                        {isActive ? <i className="fas fa-check-circle text-[10px]"></i> : <i className="fas fa-plus-circle text-[10px] opacity-40"></i>}
                        <span className="uppercase">{term}</span>
                        {isOriginal && <span className="text-[7px] bg-white/20 px-1.5 py-0.5 rounded font-black tracking-tighter">BUSCA ORIGINAL</span>}
                      </span>
                      <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black tabular-nums ${isActive ? (isOriginal ? 'bg-slate-700 text-white' : 'bg-blue-500 text-white') : 'bg-slate-200 text-slate-500'}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
              {expansion && (
                <div className="mt-5 pt-4 border-t border-slate-50 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center text-blue-500 flex-shrink-0">
                    <i className="fas fa-brain text-xs"></i>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Dica da IA para o Catálogo</p>
                    <p className="text-xs text-slate-600 font-medium leading-relaxed italic">
                      "{expansion.explanation}"
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center mb-6 px-1">
           <div className="flex items-center gap-4">
             <div className="flex flex-col">
               <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Resultados Ordenados por Relevância</span>
               <span className="text-lg font-black text-slate-900 leading-none tabular-nums">
                {filteredData.length.toLocaleString()}
               </span>
             </div>
             {deferredSearchTerm !== searchInput && (
               <div className="flex items-center gap-2 bg-blue-50 px-3 py-1.5 rounded-full border border-blue-100">
                 <div className="w-2 h-2 bg-blue-500 rounded-full animate-ping"></div>
                 <span className="text-[9px] font-black text-blue-600 uppercase tracking-widest">Recalculando ranking...</span>
               </div>
             )}
           </div>
           <PaginationControls discrete={true} />
        </div>

        <div className="grid grid-cols-1 gap-4">
          {paginatedData.length === 0 ? (
            <div className={`py-32 flex flex-col items-center justify-center bg-white rounded-[2rem] border-2 border-dashed border-slate-200 text-slate-300`}>
              {existsInOtherCatalog ? (
                <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                   <div className={`w-20 h-20 bg-${isService ? 'emerald' : 'blue'}-50 text-${isService ? 'emerald' : 'blue'}-500 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl border border-${isService ? 'emerald' : 'blue'}-100`}>
                      <i className="fas fa-exchange-alt"></i>
                   </div>
                   <h3 className={`font-black text-lg uppercase tracking-tight text-slate-800`}>Item encontrado na outra aba!</h3>
                   <p className="text-sm font-medium mt-2 text-slate-500 max-w-sm mx-auto">
                     Você está na aba de <b>{isService ? 'SERVIÇOS' : 'MATERIAIS'}</b>, mas encontramos resultados para sua busca em <b>{isService ? 'MATERIAIS' : 'SERVIÇOS'}</b>.
                   </p>
                   <button 
                     onClick={() => {setView(isService ? 'catmat' : 'catser'); setCurrentPage(1)}}
                     className={`mt-8 px-8 py-4 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] hover:scale-105 transition-transform shadow-xl`}
                   >
                     Alternar para {isService ? 'Materiais' : 'Serviços'}
                   </button>
                </div>
              ) : (
                <>
                  <i className="fas fa-search-minus text-6xl mb-6"></i>
                  <h3 className="font-black text-sm uppercase tracking-[0.3em]">Nada foi encontrado</h3>
                  <p className="text-xs font-medium mt-2">Tente ativar outras tags de sugestão da IA.</p>
                </>
              )}
            </div>
          ) : (
            paginatedData.map((item: any, idx) => {
              const code = item.codigoMaterial || item.codigoServico;
              const desc = item.descricaoMaterial || item.descricaoServico;
              return (
                <div key={`${idx}-${code}`} className={`bg-white p-4 rounded-xl border border-slate-100 shadow-sm flex items-center justify-between group hover:border-${themeColor}-200 transition-all hover:shadow-md`}>
                  <div className="flex-1 pr-6">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={`text-xs font-bold text-white ${isService ? 'bg-blue-600' : 'bg-emerald-600'} px-2 py-1 rounded-md`}>
                        CÓD {code}
                      </span>
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-md text-${themeColor}-700 bg-${themeColor}-50`}>
                        {toSentenceCase(item.classeDescricao)}
                      </span>
                    </div>
                    <h4 className={`text-lg font-medium text-slate-900 group-hover:text-${themeColor}-600 leading-snug transition-colors`}>
                      {toSentenceCase(desc)}
                    </h4>
                    <div className="flex items-center gap-2 mt-2">
                      <div className="w-1.5 h-1.5 bg-slate-300 rounded-full"></div>
                      <p className="text-xs font-medium text-slate-500">
                        {toSentenceCase(item.grupoDescricao)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center">
                     <button 
                       onClick={() => {
                          navigator.clipboard.writeText(String(code));
                          const btn = document.getElementById(`btn-copy-${code}`);
                          if (btn) {
                            const icon = btn.querySelector('i');
                            if (icon) {
                              icon.className = 'fas fa-check text-emerald-500 text-base scale-110 transition-transform';
                              setTimeout(() => {
                                icon.className = 'fas fa-copy text-base scale-100 transition-transform';
                              }, 2000);
                            }
                          }
                       }}
                       id={`btn-copy-${code}`}
                       className="w-10 h-10 rounded-lg bg-transparent text-slate-400 flex items-center justify-center hover:bg-slate-100 hover:text-blue-600 transition-all active:scale-95"
                       title="Copiar Código"
                     >
                       <i className="fas fa-copy text-base"></i>
                     </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <PaginationControls />
      </main>
    </div>
  );
}

// =====================
// Accounting Module
// =====================
const ACC = {
  currency: 'د.ب',
  expensesKey: 'naseej_expenses_v1',
  charts: {}
};

function $(id){ return document.getElementById(id); }

function fmtMoney(x){
  const n = Number(x || 0);
  return n.toLocaleString('ar-BH',{minimumFractionDigits:3}) + ' ' + ACC.currency;
}

function isoToday(){
  return new Date().toISOString().split('T')[0];
}

function loadExpenses(){
  return JSON.parse(localStorage.getItem(ACC.expensesKey) || '[]');
}

function saveExpenses(list){
  localStorage.setItem(ACC.expensesKey, JSON.stringify(list));
}

// اسحب الحجوزات من السيرفر
async function fetchBookings(from, to){
  const q = (from && to) ? `?from=${from}&to=${to}` : '';
  const r = await fetch('/api/bookings'+q,{credentials:'same-origin'});
  return r.json();
}

// تحديث لوحة المحاسبة
async function accRefresh(){
  const from = $('accFrom').value;
  const to   = $('accTo').value;

  const bookings = await fetchBookings(from,to);
  const expenses = loadExpenses();

  const income = bookings.reduce((s,b)=>s+Number(b.price||0),0);
  const expense = expenses
    .filter(e => (!from || e.date>=from) && (!to || e.date<=to))
    .reduce((s,e)=>s+Number(e.amount||0),0);

  $('kpiIncome').textContent = fmtMoney(income);
  $('kpiExpense').textContent = fmtMoney(expense);

  const net = income-expense;
  $('kpiNet').textContent = fmtMoney(net);
  $('kpiNet').style.color = net>=0 ? '#7CFFB2' : '#FF6B6B';

  drawSimpleChart(bookings, expenses);
}

// رسم منحنى بسيط
function drawSimpleChart(bookings, expenses){
  if(ACC.charts.main) ACC.charts.main.destroy();

  const labels = bookings.map(b=>b.date);
  const data = bookings.map(b=>Number(b.price||0));

  ACC.charts.main = new Chart(
    document.getElementById('chartMonthly'),
    {
      type:'line',
      data:{
        labels,
        datasets:[{
          label:'الدخل',
          data,
          borderColor:'#7CFFB2',
          fill:false
        }]
      }
    }
  );
}

// إضافة مصروف
document.addEventListener('DOMContentLoaded',()=>{
  $('accFrom').value = isoToday().slice(0,7)+'-01';
  $('accTo').value   = isoToday();

  $('accRefresh').onclick = accRefresh;

  $('exAdd').onclick = ()=>{
    const ex = {
      id: Date.now(),
      date: $('exDate').value || isoToday(),
      title: $('exTitle').value,
      cat: $('exCat').value,
      amount: Number($('exAmount').value)
    };
    if(!ex.title || !ex.amount) return alert('اكمل بيانات المصروف');

    const all = loadExpenses();
    all.push(ex);
    saveExpenses(all);

    $('exTitle').value='';
    $('exAmount').value='';

    accRefresh();
  };
});
